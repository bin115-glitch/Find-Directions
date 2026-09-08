// initialize map
        const map = L.map('map').setView([21.03, 105.81], 12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

        // Global pole snap threshold (km). Adjust to change how far from a point we will consider poles.
        // Default 1.0 km (1000 m). You can reduce to 0.5 for stricter snapping.
        let POLE_SNAP_THRESHOLD_KM = 1.0;

        // elements
        const statusEl = document.getElementById('status');
        const routeCheckboxes = document.getElementById('routeCheckboxes');
        const poleCheckboxes = document.getElementById('poleCheckboxes');

        // state for drawing
        const dataLayer = L.layerGroup().addTo(map);
        const segsByRoute = new Map(); // routeId -> segments[]
        const nodesByRoute = new Map(); // routeId -> nodes[]
        // aggregated nodes across loaded routes (used for snapping/search)
        let nodes = [];
        // coordinate pick state
        let clickMarker = null;
        let isCoordinateMode = false;
        let coordinateModeType = 'start'; // 'start' or 'end'
        let startPointMarker = null;
        let endPointMarker = null;
        let startPointCoords = null;
        let endPointCoords = null;

        // poles state & layer
        const poleSetsData = new Map(); // key -> parsed pole list
        let poles = [];
        const polesLayer = L.layerGroup().addTo(map);
        const poleLinksLayer = L.layerGroup().addTo(map);
        let poleCodeIndex = new Map(); // normCode -> Array<pole>
        let nodeCodeIndex = new Map(); // normCode -> Array<node>
        // layer for nearby search results
        const nearbyLayer = L.layerGroup().addTo(map);
        const nearbyStartLayer = L.layerGroup().addTo(map);
        const nearbyEndLayer = L.layerGroup().addTo(map);
        const nearbyPoleStartLayer = L.layerGroup().addTo(map);
        // layer for drawn network paths
        let walkingRoutesLayer = L.layerGroup().addTo(map);
        // layer for cot trung the (medium voltage poles)
        const cotTrungLayer = L.layerGroup().addTo(map);
        // layer for lines (đường dây)
        const cotLinesLayer = L.layerGroup().addTo(map);
        // candidate containers
        let startNearbyCandidates = [];
        let endNearbyCandidates = [];
        // map alternate/missing node IDs to canonical node IDs
        let nodeIdMap = new Map();

        // Style definitions for different pole types
        const COT_STYLE = {
            cot: { color: '#ff6b35', radius: 4, label: 'Cột trung thế' },
            tba: { color: '#4ecdc4', radius: 5, label: 'Trạm biến áp' }
        };

        // simple layer for node markers (kept within dataLayer for easy clearing)

        // parse latlng strings like in map_data.html
        function parseLatLngString(str) {
            if (!str) return [];
            return String(str).split(';').map(p => {
                const m = (p || '').match(/-?\d+(?:\.\d+)?/g);
                if (!m || m.length < 2) return null;
                return [parseFloat(m[0]), parseFloat(m[1])];
            }).filter(Boolean);
        }

        function parsePoleTableArray(arr) {
            if (!Array.isArray(arr)) return [];
            return arr.map(p => {
                let lat = null;
                let lng = null;
                if (p.lat != null && p.lng != null) {
                    lat = parseFloat(p.lat);
                    lng = parseFloat(p.lng);
                } else {
                    const latlng = String(p.latlng || '').match(/-?\d+(?:\.\d+)?/g);
                    if (!latlng || latlng.length < 2) return null;
                    lat = parseFloat(latlng[0]);
                    lng = parseFloat(latlng[1]);
                }
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                return {
                    id: p.id || p.code || p.name || 'pole',
                    code: p.code || '',
                    trubangduonglist: p.trubangduonglist || '',
                    aheadcode: p.aheadcode || '',
                    lat,
                    lng,
                    type: p.type || p.typedevice || 'cot',
                    name: p.name || ''
                };
            }).filter(Boolean);
        }

        // --- cot trung the (KML/JSON) manifest loader + UI ---
        const COT_TRUNG_MANIFEST_FALLBACK = [
            // Example entries you can edit: { key: 'NAN_QuyChau', name: 'Quỳ Châu (NAN)', url: './cot_trung_tuyen/json_cot/NAN/NghệAn_QuỳChâu_TBA.json' }
        ];
        let COT_TRUNG_INDEX_DATA = null;
        let COT_TRUNG_MANIFEST_CACHE = [];

        // Từ dòng 159: let GROUPING_MANIFEST = null; => xoá/comment
        // // let GROUPING_MANIFEST = null;

        async function loadCotTrungManifest() {
            const cont = document.getElementById('cottrungtuyenCheckboxes');
            if (!cont) return;
            cont.innerHTML = 'Đang tải danh sách cột trung thế...';
            const manifestPath = '../cot_trung_tuyen/json_cot/manifest.json';
            const indexPath = '../cot_trung_tuyen/json_cot/index2.json';
            try {
                console.log('Loading cot manifest from', manifestPath);
                const [manifestResp, indexResp] = await Promise.all([
                    fetch(manifestPath),
                    fetch(indexPath).catch(() => null)
                ]);
                if (indexResp && indexResp.ok) {
                    try {
                        COT_TRUNG_INDEX_DATA = await indexResp.json();
                    } catch (idxErr) {
                        console.warn('Failed to parse index2.json', idxErr);
                        COT_TRUNG_INDEX_DATA = null;
                    }
                } else {
                    COT_TRUNG_INDEX_DATA = null;
                }
                if (!manifestResp.ok) throw new Error('no manifest');
                const j = await manifestResp.json();
                let items = [];
                if (Array.isArray(j)) items = j;
                else items = j.table || j.items || j.data || [];
                // resolve relative URLs in manifest items relative to manifest directory
                const baseDir = manifestPath.substring(0, manifestPath.lastIndexOf('/'));
                const resolved = items.map(it => {
                    const copy = Object.assign({}, it);
                    if (copy.url && !copy.url.match(/^[a-zA-Z]+:\/\//) && !copy.url.startsWith('/')) {
                        // strip leading ./ if present
                        let u = copy.url.replace(/^\.\//, '');
                        // if url wrongly includes 'json_cot/' prefix while baseDir already points to json_cot, remove duplicate
                        const baseEnds = baseDir.replace(/\/+$/, '').split('/').pop();
                        if (baseEnds === 'json_cot' && u.startsWith('json_cot/')) {
                            u = u.replace(/^json_cot\//, '');
                        }
                        copy.url = baseDir + '/' + u;
                    }
                    return copy;
                });
                COT_TRUNG_MANIFEST_CACHE = resolved.slice();
                buildCotTrungUI(resolved);
                return;
            } catch (err) {
                console.warn('No manifest; using fallback or scanning directories', err);
            }
            // fallback
            if (COT_TRUNG_MANIFEST_FALLBACK.length) {
                buildCotTrungUI(COT_TRUNG_MANIFEST_FALLBACK);
            } else {
                // Từ dòng 205 - bỏ luôn thông báo fallback "Không có manifest..."
                // // cont.innerHTML = ...
            }
        }

        function buildCotTrungUI(items) {
            const cont = document.getElementById('cottrungtuyenCheckboxes');
            if (!cont) return;
            cont.innerHTML = '';

            const indexRegions = (COT_TRUNG_INDEX_DATA && COT_TRUNG_INDEX_DATA.regions) || null;
            const decodeText = (val) => { try { return decodeURIComponent(val); } catch (e) { return val; } };
            const normalizeCotUrl = (raw) => {
                if (!raw) return '';
                if (/^[a-zA-Z]+:\/\//.test(raw)) return raw;
                if (raw.startsWith('./') || raw.startsWith('../')) return raw;
                if (raw.startsWith('/')) return '.' + raw;
                return raw;
            };
            const normalizeDistrictKey = (name) => String(name || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/\s+/g, '')
                .toLowerCase();
            const normalizeFileName = (s) => {
                if (!s) return '';
                try {
                    s = s.split('/').pop().split('\\').pop();
                } catch (e) { }
                // Convert đ/Đ to d/D first (NFD doesn't handle these)
                return s.toLowerCase()
                    .replace(/đ/g, 'd')
                    .replace(/Đ/g, 'd')
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '');
            };
            const detectCotFileType = (str) => {
                const nm = normalizeFileName(str);
                if (!nm) return 'unknown';

                // Check for line files - must contain both 'duong/đường' AND 'day/dây'
                const hasLine = (nm.includes('duong') && nm.includes('day')) ||
                    (nm.includes('đường') && nm.includes('dây')) ||
                    nm.includes('duong_day') ||
                    nm.includes('duongday') ||
                    nm.includes('duong-day');

                if (hasLine) return 'line';
                if (nm.includes('tba')) return 'tba';
                return 'cot';
            };
            const selectPreferredCotFile = (preferences = ['line', 'cot', 'tba']) => {
                const filesSel = document.getElementById('cottrungFilesSelect');
                if (!filesSel || !filesSel.options.length) return;
                const options = Array.from(filesSel.options).filter(opt => !opt.disabled);
                if (!options.length) return;
                const prefList = Array.isArray(preferences) ? preferences : [preferences];
                let target = null;
                for (const pref of prefList) {
                    target = options.find(opt => {
                        const optType = opt.dataset && opt.dataset.fileType;
                        if (optType) return optType === pref;
                        return detectCotFileType(opt.dataset && opt.dataset.url ? opt.dataset.url : opt.text) === pref;
                    });
                    if (target) break;
                }
                if (!target) target = options[0];
                const idx = options.indexOf(target);
                if (idx >= 0) {
                    filesSel.selectedIndex = idx;
                    filesSel.dispatchEvent(new Event('change'));
                }
            };

            async function fetchRegionDirectories(regionKey, regionOption) {
                const dirs = new Map();
                let baseUrl = null;
                const rawUrl = regionOption && regionOption.dataset && regionOption.dataset.url;
                if (rawUrl) {
                    baseUrl = normalizeCotUrl(rawUrl);
                } else if (regionKey) {
                    baseUrl = `./cot_trung_tuyen/json_cot/${regionKey}`;
                }
                if (!baseUrl) return dirs;
                if (!baseUrl.endsWith('/')) baseUrl += '/';
                try {
                    const resp = await fetch(baseUrl);
                    if (!resp.ok) return dirs;
                    const txt = await resp.text();
                    const re = /href="([^"]+\/)"/gi;
                    let m;
                    const seen = new Set();
                    while ((m = re.exec(txt)) !== null) {
                        let href = m[1];
                        if (!href || href.startsWith('../') || href.startsWith('?') || href.startsWith('#')) continue;
                        if (/\.json\/?$/i.test(href)) continue;
                        let namePart = href.replace(/\/+$/, '');
                        if (!namePart || namePart === '.' || namePart === '..') continue;
                        let decodedName = namePart;
                        try { decodedName = decodeURIComponent(namePart); } catch (err) { }
                        const norm = normalizeDistrictKey(decodedName);
                        if (!norm || seen.has(norm)) continue;
                        seen.add(norm);
                        let fullUrl = href;
                        if (!href.startsWith('http')) {
                            fullUrl = baseUrl + href;
                        }
                        fullUrl = fullUrl.replace(/\/+$/, '');
                        dirs.set(decodedName, fullUrl);
                    }
                } catch (err) {
                    console.warn('fetchRegionDirectories failed', regionKey, err);
                }
                return dirs;
            }

            const regionLabel = document.createElement('label');
            regionLabel.textContent = 'Chọn khu vực:';
            regionLabel.style.display = 'block';
            regionLabel.style.marginBottom = '6px';
            cont.appendChild(regionLabel);

            const regionSel = document.createElement('select');
            regionSel.id = 'cottrungRegionSelect';
            regionSel.style.width = '50%';
            regionSel.style.marginBottom = '8px';
            const emptyOpt = document.createElement('option'); emptyOpt.value = ''; emptyOpt.text = '-- Chọn --';
            regionSel.appendChild(emptyOpt);
            items.forEach(it => {
                const key = it.key || it.id || (it.url && it.url.split('/').pop()) || JSON.stringify(it);
                const name = it.name || it.title || it.key || key;
                const url = it.url || it.path || it.file;
                const opt = document.createElement('option');
                opt.value = key;
                opt.text = name;
                opt.dataset.url = url;
                if (Array.isArray(it.xa) && it.xa.length) {
                    try { opt.dataset.xa = JSON.stringify(it.xa); } catch (e) { }
                }
                regionSel.appendChild(opt);
            });
            cont.appendChild(regionSel);

            const cotxa = document.createElement('select');
            cotxa.id = 'XaRegionSelect';
            cotxa.style.width = '48%';
            cotxa.style.left = '4%';
            cotxa.style.display = 'none';
            cotxa.disabled = true;
            const emptyOptXa = document.createElement('option');
            emptyOptXa.value = '';
            emptyOptXa.text = '-- Chọn xã/huyện --';
            cotxa.appendChild(emptyOptXa);
            cont.appendChild(cotxa);

            const filesLabel = document.createElement('label');
            filesLabel.textContent = 'Chọn file cột trung thế:';
            filesLabel.style.display = 'block';
            filesLabel.style.margin = '6px 0 4px 0';
            cont.appendChild(filesLabel);
            const filesSel = document.createElement('select');
            filesSel.id = 'cottrungFilesSelect';
            filesSel.style.width = '100%';
            cont.appendChild(filesSel);

            const populateFilesFromIndex = (regionKey, districtName) => {
                filesSel.innerHTML = '';
                if (!regionKey || !districtName || !indexRegions || !indexRegions[regionKey]) return false;
                const list = indexRegions[regionKey][districtName];
                if (!Array.isArray(list) || !list.length) return false;
                let added = false;
                list.forEach(fileInfo => {
                    const opt = document.createElement('option');
                    const displayName = decodeText(fileInfo.name || fileInfo.url || 'file');
                    const normalizedUrl = normalizeCotUrl(fileInfo.url || '');

                    // Extract filename from URL for better type detection
                    const fileName = (normalizedUrl || displayName).split('/').pop().split('\\').pop();
                    const fileType = detectCotFileType(fileName);

                    // Debug logging
                    if (fileName.includes('Đường') || fileName.includes('duong') || fileName.toLowerCase().includes('duong')) {
                        console.log('🔍 Detecting file type:', {
                            displayName,
                            normalizedUrl,
                            fileName,
                            fileType,
                            normalizedFileName: normalizeFileName(fileName)
                        });
                    }

                    opt.text = displayName;
                    opt.value = normalizedUrl || displayName;
                    opt.dataset.url = normalizedUrl;
                    opt.dataset.fileType = fileType;
                    opt.dataset.key = `${regionKey}__${districtName}__${displayName}`;
                    filesSel.appendChild(opt);
                    added = true;
                });
                return added;
            };

            const populateDistrictOptions = async (regionKey, regionOpt) => {
                cotxa.innerHTML = '';
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.text = '-- Chọn xã/huyện --';
                cotxa.appendChild(placeholder);
                cotxa.disabled = true;
                cotxa.style.display = 'none';

                const districtMap = new Map();
                const upsert = (label, updater) => {
                    if (!label) return;
                    const norm = normalizeDistrictKey(label);
                    if (!norm) return;
                    if (!districtMap.has(norm)) {
                        districtMap.set(norm, { displayName: label });
                    }
                    const entry = districtMap.get(norm);
                    if (!entry.displayName) entry.displayName = label;
                    updater(entry);
                };

                if (indexRegions && indexRegions[regionKey]) {
                    Object.keys(indexRegions[regionKey]).forEach(name => {
                        upsert(name, entry => {
                            entry.indexName = name;
                            entry.hasIndex = true;
                            entry.displayName = name;
                        });
                    });
                }
                if (regionOpt && regionOpt.dataset && regionOpt.dataset.xa) {
                    try {
                        const xaArr = JSON.parse(regionOpt.dataset.xa);
                        if (Array.isArray(xaArr)) {
                            xaArr.forEach(name => {
                                upsert(name, entry => {
                                    entry.manifestName = name;
                                    if (!entry.displayName) entry.displayName = name;
                                });
                            });
                        }
                    } catch (e) { /* ignore */ }
                }
                const dirMap = await fetchRegionDirectories(regionKey, regionOpt);
                if (dirMap && dirMap.size) {
                    dirMap.forEach((dirUrl, dirName) => {
                        upsert(dirName, entry => {
                            entry.dirName = dirName;
                            entry.dirUrl = dirUrl;
                            entry.hasDirectory = true;
                            if (!entry.displayName) entry.displayName = dirName;
                        });
                    });
                }

                const entries = Array.from(districtMap.values()).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'vi', { sensitivity: 'base' }));
                entries.forEach(entry => {
                    const opt = document.createElement('option');
                    opt.value = entry.displayName || entry.indexName || entry.dirName || '';
                    opt.text = entry.displayName || opt.value;
                    if (entry.indexName) opt.dataset.indexName = entry.indexName;
                    if (entry.dirUrl) opt.dataset.dirUrl = entry.dirUrl;
                    if (!entry.hasIndex) opt.text += ' (chưa có dữ liệu)';
                    cotxa.appendChild(opt);
                });

                if (entries.length) {
                    cotxa.style.display = '';
                    cotxa.disabled = false;
                    return true;
                }
                return false;
            };

            regionSel.addEventListener('change', async (ev) => {
                const sel = ev.currentTarget;
                const opt = sel.options[sel.selectedIndex];
                const regionKey = opt && opt.value;
                const url = opt && opt.dataset && opt.dataset.url;
                filesSel.innerHTML = '';
                const hasDistricts = await populateDistrictOptions(regionKey, opt);
                if (hasDistricts) return;
                if (!url) {
                    const o = document.createElement('option'); o.text = '-- Không có --'; filesSel.appendChild(o); return;
                }
                if (url.toLowerCase().endsWith('.json')) {
                    await loadFilesForRegion(regionKey, url);
                    return;
                }
                await loadFilesForRegion(regionKey, url);
            });

            cotxa.addEventListener('change', async (ev) => {
                const sel = ev.currentTarget; const xa = sel.value;
                if (!xa) { filesSel.innerHTML = ''; return; }
                const regionOpt = regionSel.options[regionSel.selectedIndex];
                const regionKey = regionOpt && regionOpt.value;
                if (!regionKey) return;
                const chosen = sel.options[sel.selectedIndex];
                const indexName = chosen && chosen.dataset && chosen.dataset.indexName;
                const dirUrl = chosen && chosen.dataset && chosen.dataset.dirUrl;
                let populated = false;
                if (indexName) {
                    populated = populateFilesFromIndex(regionKey, indexName);
                }
                if (!populated) {
                    populated = populateFilesFromIndex(regionKey, xa);
                }
                if (!populated && dirUrl) {
                    populated = await loadFilesForRegion(regionKey + '__' + xa, dirUrl);
                }
                if (!populated) {
                    const baseUrl = regionOpt && regionOpt.dataset && regionOpt.dataset.url;
                    if (!baseUrl) return;
                    const directoryUrl = (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) + '/' + encodeURIComponent(xa);
                    populated = await loadFilesForRegion(regionKey + '__' + xa, directoryUrl);
                }
                if (populated) {
                    selectPreferredCotFile(['line', 'cot', 'tba']);
                }
            });

            filesSel.addEventListener('change', async (ev) => {
                const sel = ev.currentTarget;
                const opt = sel.options[sel.selectedIndex];
                const url = opt && opt.dataset && opt.dataset.url;
                const key = opt && opt.dataset && opt.dataset.key;
                if (!url) return;

                const presetFileType = opt && opt.dataset && opt.dataset.fileType;
                const detectedFileType = detectCotFileType(url);
                const optType = presetFileType || detectedFileType;

                console.log('🔍 File selected:', {
                    url,
                    key,
                    fileName: url.split('/').pop(),
                    presetFileType,
                    detectedFileType,
                    finalOptType: optType
                });

                if (optType === 'tba') {
                    console.log('📍 Loading TBA (trạm biến áp)...');
                    await loadCotTrungSet(key || opt.value, url, 'tba');
                } else if (optType === 'line') {
                    console.log('📏 Loading LINES (đường dây)...');
                    await loadAndDrawLines(url);
                } else {
                    console.log('🔌 Loading COT (cột điện)...');
                    await loadCotTrungSet(key || opt.value, url, 'cot');
                }
            });
        }

        // Attempt to load a list of files for a region. We expect either:
        // - region manifest at url + '/manifest.json' returning array of {key,name,url}
        // - or url is a directory; try fetch url + '/index.json' or list single file if url ends with .json
        async function loadFilesForRegion(key, urlBase) {
            const filesSel = document.getElementById('cottrungFilesSelect');
            if (!filesSel) return false;
            filesSel.innerHTML = '';
            let appended = false;
            // If key encodes region__district and grouping manifest is available, use it directly
            try {
                if (GROUPING_MANIFEST && typeof key === 'string' && key.includes('__')) {
                    const parts = key.split('__');
                    const regionCode = parts[0];
                    const districtName = parts[1];
                    if (GROUPING_MANIFEST[regionCode] && GROUPING_MANIFEST[regionCode][districtName]) {
                        const arr = GROUPING_MANIFEST[regionCode][districtName];
                        arr.forEach(p => {
                            // convert backslash paths to web url
                            const web = '/' + p.replace(/\\/g, '/');
                            const fname = web.split('/').pop();
                            const opt = document.createElement('option');
                            opt.text = fname;
                            opt.value = web;
                            opt.dataset.url = web;
                            opt.dataset.fileType = detectCotFileType(web);
                            opt.dataset.key = key + '__' + fname;
                            filesSel.appendChild(opt);
                            appended = true;
                        });
                        return appended;
                    }
                }
            } catch (e) { /* ignore and continue to normal resolution */ }
            // if urlBase points to a single .json file, use it
            if (urlBase.toLowerCase().endsWith('.json')) {
                const fname = urlBase.split('/').pop();
                const opt = document.createElement('option');
                opt.text = (function (u) { try { return decodeURIComponent(u); } catch (e) { return u; } })(fname);
                opt.value = urlBase;
                opt.dataset.url = urlBase;
                opt.dataset.fileType = detectCotFileType(urlBase);
                opt.dataset.key = key + '__' + fname; filesSel.appendChild(opt);
                appended = true;
                return appended;
            }
            // do not attempt to fetch nested manifest/index files inside province folders
            // final fallback: show message option
            const opt = document.createElement('option');
            opt.text = '-- Không tìm thấy file (Hãy cập nhật index2.json) --';
            opt.disabled = true;
            filesSel.appendChild(opt);
            return appended;
        }

        function fitMapToLatLngs(latlngs) {
            if (!Array.isArray(latlngs) || !latlngs.length) return;
            const bounds = [];
            latlngs.forEach(pt => {
                if (!pt || pt.length < 2) return;
                const lat = Number(pt[0]);
                const lng = Number(pt[1]);
                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    bounds.push([lat, lng]);
                }
            });
            if (bounds.length) {
                try { map.fitBounds(bounds, { padding: [20, 20] }); } catch (e) { }
            }
        }

        async function loadCotTrungSet(key, url, iconType) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const j = await resp.json();
                let arr = j.table || j.items || j.data || j || [];
                if (!Array.isArray(arr)) {
                    if (Array.isArray(j.features)) {
                        arr = j.features.map(feat => {
                            const geom = feat && feat.geometry;
                            const props = (feat && feat.properties) || {};
                            if (!geom) return null;
                            if (geom.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
                                const lng = parseFloat(geom.coordinates[0]);
                                const lat = parseFloat(geom.coordinates[1]);
                                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                                    return {
                                        id: props.id || props.name || props.code,
                                        name: props.name || props.title || props.code,
                                        code: props.code || props.id || props.name,
                                        lat,
                                        lng,
                                        type: props.type || iconType || 'cot'
                                    };
                                }
                            }
                            return null;
                        }).filter(Boolean);
                    } else {
                        arr = [];
                    }
                }
                const parsed = parsePoleTableArray(arr);
                poleSetsData.set(key, parsed);
                // render parsed poles immediately in a dedicated layer (cot trung the)
                try { cotTrungLayer.clearLayers(); } catch (e) { }
                const bounds = [];
                parsed.forEach(p => {
                    if (!p || p.lat == null || p.lng == null) return;
                    bounds.push([p.lat, p.lng]);
                    const style = COT_STYLE[iconType] || COT_STYLE.cot;

                    let mk;
                    if (iconType === 'cot') {
                        // Use custom icon for poles
                        const icon = L.icon({
                            iconUrl: './icon/cot.png',
                            iconSize: [16, 16],
                            iconAnchor: [8, 8],
                            popupAnchor: [0, -8]
                        });
                        mk = L.marker([p.lat, p.lng], { icon: icon, title: p.name || p.code || p.id });
                    } else {
                        // Use circleMarker for TBA
                        mk = L.circleMarker([p.lat, p.lng], {
                            radius: style.radius,
                            color: '#ffffff',
                            weight: 2,
                            fillColor: style.color,
                            fillOpacity: 0.95,
                            title: p.name || p.code || p.id
                        });
                    }

                    mk.bindTooltip(`${style.label}<br>${p.name || p.code || p.id}`, { permanent: false });
                    mk.on && mk.on('click', () => {
                        const popupTitle = (iconType === 'tba') ? '<b>Trạm biến áp</b>' : '<b>Cột trung thế</b>';
                        mk.bindPopup(`${popupTitle}<br>Code: ${p.code || p.id}<br>Type: ${p.type}<br>Coordinate: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`).openPopup();
                    });
                    cotTrungLayer.addLayer(mk);
                });
                // also update pole UI/checklists so user can toggle other pole sets
                if (typeof buildPoleUI === 'function') {
                    buildPoleUI();
                } else {
                    console.warn('buildPoleUI is not defined; skipping pole UI rebuild');
                }
                rebuildPolesFromSelection();
                fitMapToLatLngs(bounds);
                console.log('Loaded cot trung the set', key, parsed.length);
            } catch (e) {
                console.warn('loadCotTrungSet failed', url, e);
            }
        }

        // Load a JSON of lines (Đường_Dây) and draw green polylines on cotLinesLayer
        async function loadAndDrawLines(url) {
            return await loadAndDrawLinesFromUrl(url);
        }

        // Normalize code string for matching (trim, uppercase)
        function normalizeCode(s) {
            if (!s && s !== 0) return '';
            return String(s).toUpperCase().replace(/\s+/g, '');
        }

        // Given a pole.trubangduonglist string (may contain separators), return array of normalized codes
        function parseTruBangDuongList(listStr) {
            if (!listStr) return [];
            return String(listStr).split(/[;,|\s]+/).map(x => normalizeCode(x)).filter(Boolean);
        }

        // Haversine distance (km)
        function calculateDistance(lat1, lon1, lat2, lon2) {
            const R = 6371; // km
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        }

        // --- Walking route / pole-routing helpers (ported from map_data.html) ---
        // Draw walking route using Valhalla or OSRM (returns { line, km } or null)
        async function drawWalkingRoute(startLat, startLng, endLat, endLng, options = {}) {
            try {
                const body = {
                    locations: [
                        { lat: startLat, lon: startLng },
                        { lat: endLat, lon: endLng }
                    ],
                    costing: 'pedestrian',
                    directions_options: { units: 'kilometers' },
                    shape_format: 'geojson',
                    instructions: false
                };
                const resp = await fetch('https://valhalla1.openstreetmap.de/route', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!resp.ok) throw new Error('Valhalla HTTP ' + resp.status);
                const data = await resp.json();
                if (!data.trip || !data.trip.legs || !data.trip.legs.length) throw new Error('No trip');
                const leg = data.trip.legs[0];
                const km = leg.summary && typeof leg.summary.length === 'number' ? leg.summary.length : null;
                let coords = [];
                if (leg.shape && leg.shape.coordinates) {
                    coords = leg.shape.coordinates.map(([lon, lat]) => [lat, lon]);
                } else if (typeof leg.shape === 'string') {
                    try {
                        coords = window.polyline ? window.polyline.decode(leg.shape, 6) : [];
                    } catch { }
                }
                if (!coords || coords.length === 0) throw new Error('Empty shape');
                if (options.clipToEnd) {
                    let bestIdx = 0;
                    let bestDist = Infinity;
                    for (let i = 0; i < coords.length; i++) {
                        const d = calculateDistance(coords[i][0], coords[i][1], endLat, endLng);
                        if (d < bestDist) { bestDist = d; bestIdx = i; }
                    }
                    coords = coords.slice(0, bestIdx + 1);
                    coords.push([endLat, endLng]);
                }
                const color = options.color || '#1e90ff';
                const weight = options.weight || 5;
                const opacity = options.opacity || 0.9;
                const line = L.polyline(coords, { color, weight, opacity });
                const targetLayer = options.layer || walkingRoutesLayer;
                if (!options.preview) targetLayer.addLayer(line);
                const last = coords[coords.length - 1];
                const off = calculateDistance(last[0], last[1], endLat, endLng);
                if (off > 0.02) {
                    const connect = L.polyline([last, [endLat, endLng]], { color, weight, opacity, dashArray: '5, 5' });
                    if (!options.preview) (options.layer || walkingRoutesLayer).addLayer(connect);
                }
                return { line, km, drawn: !options.preview };
            } catch (e) {
                try {
                    const url = `https://router.project-osrm.org/route/v1/foot/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
                    const resp2 = await fetch(url);
                    if (!resp2.ok) throw new Error('OSRM HTTP ' + resp2.status);
                    const data2 = await resp2.json();
                    if (!data2.routes || !data2.routes.length) throw new Error('OSRM no route');
                    const km2 = data2.routes[0].distance / 1000;
                    let coords2 = data2.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
                    if (options.clipToEnd) {
                        let bestIdx = 0;
                        let bestDist = Infinity;
                        for (let i = 0; i < coords2.length; i++) {
                            const d = calculateDistance(coords2[i][0], coords2[i][1], endLat, endLng);
                            if (d < bestDist) { bestDist = d; bestIdx = i; }
                        }
                        coords2 = coords2.slice(0, bestIdx + 1);
                        coords2.push([endLat, endLng]);
                    }
                    const color = options.color || '#1e90ff';
                    const line = L.polyline(coords2, { color, weight: options.weight || 5, opacity: options.opacity || 0.9 });
                    if (!options.preview) (options.layer || walkingRoutesLayer).addLayer(line);
                    return { line, km: km2, drawn: !options.preview };
                } catch (e2) {
                    console.warn('Routing error:', e2);
                    return null;
                }
            }
        }

        // Dijkstra on pole graph; then use walking routing (Valhalla/OSRM) per segment
        async function routeViaPolesWalk(startLat, startLng, endLat, endLng, options = {}) {
            if (!poles || poles.length === 0) return null;
            // Build code-based adjacency and proximity adjacency (used as fallback).
            try { if (!window.poleAdjacency || (window.poleAdjacency && window.poleAdjacency.size === 0)) buildPoleCodeAdjacency(); } catch (err) { console.warn('buildPoleCodeAdjacency failed', err); }
            try { if (!window.poleProximityAdj || (window.poleProximityAdj && window.poleProximityAdj.size === 0)) buildPoleProximityAdj(); } catch (err) { console.warn('buildPoleProximityAdj failed', err); }
            // Build combined adjacency: include code edges (preferred) and proximity edges as fallback
            const combinedAdj = new Map();
            for (let i = 0; i < poles.length; i++) combinedAdj.set(i, []);
            // add code edges
            if (window.poleAdjacency && window.poleAdjacency.size) {
                for (const [k, nbrs] of window.poleAdjacency.entries()) {
                    nbrs.forEach(n => {
                        if (!combinedAdj.get(k).some(x => x.to === n.to)) combinedAdj.get(k).push({ to: n.to, cost: n.cost, source: 'code' });
                    });
                }
            }
            // add proximity edges where missing
            if (window.poleProximityAdj && window.poleProximityAdj.size) {
                for (const [k, nbrs] of window.poleProximityAdj.entries()) {
                    nbrs.forEach(n => {
                        if (!combinedAdj.get(k).some(x => x.to === n.to)) combinedAdj.get(k).push({ to: n.to, cost: n.cost, source: 'proximity' });
                    });
                }
            }
            const poleAdj = combinedAdj;
            const snapKm = POLE_SNAP_THRESHOLD_KM;
            const startNeighbors = [], endNeighbors = [];
            for (let i = 0; i < poles.length; i++) {
                const ps = poles[i];
                const ds = calculateDistance(startLat, startLng, ps.lat, ps.lng);
                if (ds <= snapKm) startNeighbors.push({ idx: i, cost: ds });
                const de = calculateDistance(endLat, endLng, ps.lat, ps.lng);
                if (de <= snapKm) endNeighbors.push({ idx: i, cost: de });
            }
            console.log('Debug: routeViaPolesWalk neighbors', { startNeighborsCount: startNeighbors.length, endNeighborsCount: endNeighbors.length, snapKm });
            if (startNeighbors.length === 0 || endNeighbors.length === 0) return null;
            const n = poles.length;
            const dist = new Array(n).fill(Infinity);
            const prev = new Array(n).fill(-1);
            const visited = new Array(n).fill(false);
            const pq = [];
            startNeighbors.forEach(s => { dist[s.idx] = s.cost; pq.push({ idx: s.idx, d: dist[s.idx] }); });
            const push = (obj) => { pq.push(obj); pq.sort((a, b) => a.d - b.d); };
            while (pq.length) {
                const { idx, d } = pq.shift();
                if (visited[idx]) continue;
                visited[idx] = true;
                if (d > dist[idx]) continue;
                const neighbors = poleAdj.get(idx) || [];
                for (const e of neighbors) {
                    const nd = d + e.cost;
                    if (nd < dist[e.to]) {
                        dist[e.to] = nd;
                        prev[e.to] = idx;
                        push({ idx: e.to, d: nd });
                    }
                }
            }
            let bestEnd = null;
            for (const t of endNeighbors) {
                const total = dist[t.idx] + t.cost;
                if (!isFinite(total)) continue;
                if (!bestEnd || total < bestEnd.total) bestEnd = { idx: t.idx, total };
            }
            if (!bestEnd) return null;
            const pathIdx = [];
            let cur = bestEnd.idx;
            while (cur !== -1) { pathIdx.push(cur); cur = prev[cur]; }
            pathIdx.reverse();
            const latlngs = [];
            latlngs.push([startLat, startLng]);
            for (const i of pathIdx) latlngs.push([poles[i].lat, poles[i].lng]);
            latlngs.push([endLat, endLng]);
            let totalKm = 0;
            // draw legs: for pole->pole pairs, if code-based edge exists draw via routing; otherwise draw straight lines
            for (let i = 0; i < latlngs.length - 1; i++) {
                const a = latlngs[i];
                const b = latlngs[i + 1];
                // determine if this is a pole->pole segment (i between 1 and pathIdx.length)
                if (i > 0 && i < latlngs.length - 2) {
                    // pole indices in pathIdx: element (i-1) and (i)
                    const pi = pathIdx[i - 1];
                    const pj = pathIdx[i];
                    const isCodeEdge = (window.poleCodeAdj && window.poleCodeAdj.has(pi) && window.poleCodeAdj.get(pi).has(pj));
                    if (isCodeEdge) {
                        // prefer walking route along roads for code-linked poles
                        const leg = await drawWalkingRoute(a[0], a[1], b[0], b[1], { color: '#1e90ff', weight: 6, opacity: 0.9, clipToEnd: i === latlngs.length - 2, preview: options.computeOnly === true, layer: options.layer });
                        if (leg && Number.isFinite(leg.km)) totalKm += leg.km;
                        else totalKm += calculateDistance(a[0], a[1], b[0], b[1]);
                    } else {
                        // unconnected poles -> straight solid line
                        const line = L.polyline([a, b], { color: '#1e90ff', weight: 4, opacity: 0.95 });
                        if (!options.computeOnly) (options.layer || walkingRoutesLayer).addLayer(line);
                        totalKm += calculateDistance(a[0], a[1], b[0], b[1]);
                    }
                } else {
                    // start->firstPole or lastPole->end: draw straight connector (user prefers direct connection)
                    const line = L.polyline([a, b], { color: '#1e90ff', weight: 6, opacity: 0.9, dashArray: (i === 0 || i === latlngs.length - 2) ? null : '6,6' });
                    if (!options.computeOnly) (options.layer || walkingRoutesLayer).addLayer(line);
                    totalKm += calculateDistance(a[0], a[1], b[0], b[1]);
                }
            }
            return { km: totalKm, drawn: !options.computeOnly };
        }

        // route via poles to a specific network node (draw straight pole-to-pole connectors)
        async function routeViaPolesToNode(startLat, startLng, endNodeId) {
            if (!poles || poles.length === 0) return null;
            if (!endNodeId) return null;
            const endNode = nodes.find(n => n.id === endNodeId);
            if (!endNode || !endNode.latlng) return null;
            const endCoords = getNodeCoordinatesSimple(endNode);
            if (!endCoords) return null;
            try { if (!window.poleAdjacency || (window.poleAdjacency && window.poleAdjacency.size === 0)) buildPoleCodeAdjacency(); } catch (err) { console.warn('buildPoleCodeAdjacency failed', err); }
            // Only use pole-based routing when code-based adjacency exists
            if (!window.poleAdjacencySource || window.poleAdjacencySource !== 'code') {
                return null;
            }
            const poleAdj = window.poleAdjacency;
            let startIdx = null, endIdx = null;
            let bestSd = Infinity, bestEd = Infinity;
            for (let i = 0; i < poles.length; i++) {
                const p = poles[i];
                const d1 = calculateDistance(startLat, startLng, p.lat, p.lng);
                if (d1 < bestSd) { bestSd = d1; startIdx = i; }
                const d2 = calculateDistance(endCoords[0], endCoords[1], p.lat, p.lng);
                if (d2 < bestEd) { bestEd = d2; endIdx = i; }
            }
            // If nearest pole to start or end is farther than threshold, skip pole-routing
            const POLE_SNAP_THRESHOLD_KM = 1.0; // 1000 m
            if (startIdx == null || endIdx == null) return null;
            if (bestSd > POLE_SNAP_THRESHOLD_KM || bestEd > POLE_SNAP_THRESHOLD_KM) {
                // too far to reasonably use poles
                return null;
            }
            const n = poles.length;
            const dist = new Array(n).fill(Infinity);
            const prev = new Array(n).fill(-1);
            const visited = new Array(n).fill(false);
            dist[startIdx] = 0;
            const pq = [{ idx: startIdx, d: 0 }];
            const push = (o) => { pq.push(o); pq.sort((a, b) => a.d - b.d); };
            while (pq.length) {
                const cur = pq.shift();
                const u = cur.idx; const d = cur.d;
                if (visited[u]) continue;
                visited[u] = true;
                if (u === endIdx) break;
                const neighbors = poleAdj.get(u) || [];
                for (const e of neighbors) {
                    const nd = d + e.cost;
                    if (nd < dist[e.to]) {
                        dist[e.to] = nd;
                        prev[e.to] = u;
                        push({ idx: e.to, d: nd });
                    }
                }
            }
            if (!visited[endIdx] && startIdx !== endIdx) return null;
            const pathIdx = [];
            let cur = endIdx;
            while (cur !== -1) { pathIdx.push(cur); cur = prev[cur]; }
            pathIdx.reverse();
            let totalKm = 0;
            const firstPole = poles[pathIdx[0]];
            if (calculateDistance(startLat, startLng, firstPole.lat, firstPole.lng) > 0.00001) {
                const line = L.polyline([[startLat, startLng], [firstPole.lat, firstPole.lng]], { color: '#1e90ff', weight: 6, opacity: 0.9 });
                walkingRoutesLayer.addLayer(line);
                totalKm += calculateDistance(startLat, startLng, firstPole.lat, firstPole.lng);
            }
            for (let i = 0; i < pathIdx.length - 1; i++) {
                const a = poles[pathIdx[i]];
                const b = poles[pathIdx[i + 1]];
                const line = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: '#1e90ff', weight: 4, opacity: 0.95, dashArray: '6,6' });
                walkingRoutesLayer.addLayer(line);
                totalKm += calculateDistance(a.lat, a.lng, b.lat, b.lng);
            }
            const lastPole = poles[pathIdx[pathIdx.length - 1]];
            if (calculateDistance(lastPole.lat, lastPole.lng, endCoords[0], endCoords[1]) > 0.00001) {
                const line = L.polyline([[lastPole.lat, lastPole.lng], [endCoords[0], endCoords[1]]], { color: '#1e90ff', weight: 6, opacity: 0.9 });
                walkingRoutesLayer.addLayer(line);
                totalKm += calculateDistance(lastPole.lat, lastPole.lng, endCoords[0], endCoords[1]);
            }
            return { km: totalKm, drawn: true };
        }

        // Choose shorter walking leg between via-poles and direct
        async function chooseBestWalkingLeg(startLat, startLng, endLat, endLng, opts = {}) {
            const targetLayer = opts.layer || walkingRoutesLayer;
            // Prefer poles-based route if available; otherwise draw a straight connector to the nearest point.
            try {
                const viaPolesPreview = await routeViaPolesWalk(startLat, startLng, endLat, endLng, { computeOnly: true });
                if (viaPolesPreview && Number.isFinite(viaPolesPreview.km)) {
                    // draw via poles for real
                    return await routeViaPolesWalk(startLat, startLng, endLat, endLng, { computeOnly: false, layer: targetLayer });
                }
            } catch (e) {
                console.warn('chooseBestWalkingLeg: pole preview failed', e);
            }

            // No pole-based route found — draw a straight solid connector between points
            try {
                const line = L.polyline([[startLat, startLng], [endLat, endLng]], { color: opts.color || '#1e90ff', weight: opts.weight || 6, opacity: (typeof opts.opacity === 'number') ? opts.opacity : 0.9 });
                targetLayer.addLayer(line);
                const km = calculateDistance(startLat, startLng, endLat, endLng);
                return { line, km };
            } catch (e) {
                console.warn('chooseBestWalkingLeg: fallback straight draw failed', e);
                return null;
            }
        }

        // --- end pole-routing helpers ---

        // Draw links between nearby poles (proximity graph)
        function drawAllPoleLinks() {
            poleLinksLayer.clearLayers();
            if (!poles || poles.length === 0) return;
            const drawnPairs = new Set();

            // build quick indexes if empty
            poleCodeIndex = new Map();
            poles.forEach(p => {
                const canonical = p.code || p.id || p.name;
                const k = normalizeCode(canonical);
                if (!k) return;
                if (!poleCodeIndex.has(k)) poleCodeIndex.set(k, []);
                poleCodeIndex.get(k).push(p);
            });

            nodeCodeIndex = new Map();
            // gather nodes from loaded nodesByRoute
            for (const [rid, nds] of nodesByRoute.entries()) {
                (nds || []).forEach(n => {
                    const candidate = (n.code || n.name || n.id || '').toString();
                    const k = normalizeCode(candidate);
                    if (!k) return;
                    if (!nodeCodeIndex.has(k)) nodeCodeIndex.set(k, []);
                    nodeCodeIndex.get(k).push(n);
                });
            }

            // match by trubangduonglist / aheadcode
            for (const pole of poles) {
                const codes = [];
                if (pole.trubangduonglist) codes.push(...parseTruBangDuongList(pole.trubangduonglist));
                if (pole.aheadcode) codes.push(...parseTruBangDuongList(pole.aheadcode));
                if (!codes.length) continue;
                const poleLatLng = [pole.lat, pole.lng];

                // match other poles via index (fast)
                const matchedPoleSet = new Set();
                codes.forEach(c => {
                    const arr = poleCodeIndex.get(c) || [];
                    arr.forEach(p => { if (p && p !== pole) matchedPoleSet.add(p); });
                });
                matchedPoleSet.forEach(other => {
                    const otherCoords = [other.lat, other.lng];
                    const key = [poleLatLng.join(','), otherCoords.join(',')].sort().join(':');
                    if (drawnPairs.has(key)) return;
                    drawnPairs.add(key);
                    const line = L.polyline([poleLatLng, otherCoords], { color: '#ff8c00', weight: 2, opacity: 0.95, dashArray: '6,6' });
                    poleLinksLayer.addLayer(line);
                });

                // match nodes via index
                const matchedNodeSet = new Set();
                codes.forEach(c => {
                    const arr = nodeCodeIndex.get(c) || [];
                    arr.forEach(n => { if (n) matchedNodeSet.add(n); });
                });
                matchedNodeSet.forEach(n => {
                    const nodeCoords = getNodeCoordinatesSimple(n);
                    if (!nodeCoords) return;
                    const key = [poleLatLng.join(','), nodeCoords.join(',')].sort().join(':');
                    if (drawnPairs.has(key)) return;
                    drawnPairs.add(key);
                    const line = L.polyline([poleLatLng, nodeCoords], { color: '#0b84ff', weight: 2, opacity: 0.9, dashArray: '6,6' });
                    poleLinksLayer.addLayer(line);
                });
            }
        }

        function clearPoleLinks() { try { poleLinksLayer.clearLayers(); } catch (e) { } }

        // Build pole adjacency using code relationships (trubangduonglist / aheadcode / code)
        function buildPoleCodeAdjacency() {
            if (!poles || poles.length === 0) {
                window.poleAdjacency = new Map();
                return;
            }
            // ensure poleCodeIndex exists
            poleCodeIndex = new Map();
            poles.forEach((p, idx) => {
                const canonical = (p.code || p.id || p.name || '').toString();
                const k = normalizeCode(canonical);
                if (!k) return;
                if (!poleCodeIndex.has(k)) poleCodeIndex.set(k, []);
                poleCodeIndex.get(k).push({ pole: p, idx });
            });

            const adj = new Map();
            for (let i = 0; i < poles.length; i++) adj.set(i, []);

            // helper to add undirected edge
            const addEdge = (a, b) => {
                if (a == null || b == null || a === b) return;
                if (!adj.has(a)) adj.set(a, []);
                if (!adj.has(b)) adj.set(b, []);
                // avoid duplicates
                if (!adj.get(a).some(x => x.to === b)) adj.get(a).push({ to: b, cost: calculateDistance(poles[a].lat, poles[a].lng, poles[b].lat, poles[b].lng) });
                if (!adj.get(b).some(x => x.to === a)) adj.get(b).push({ to: a, cost: calculateDistance(poles[a].lat, poles[a].lng, poles[b].lat, poles[b].lng) });
            };

            for (let i = 0; i < poles.length; i++) {
                const p = poles[i];
                const codes = [];
                if (p.trubangduonglist) codes.push(...parseTruBangDuongList(p.trubangduonglist));
                if (p.aheadcode) codes.push(...parseTruBangDuongList(p.aheadcode));
                // also include own code so same-code poles connect
                const own = normalizeCode(p.code || p.id || p.name || '');
                if (own) codes.push(own);

                codes.forEach(c => {
                    const matches = poleCodeIndex.get(c) || [];
                    matches.forEach(m => {
                        const j = m.idx;
                        if (j != null && j !== i) addEdge(i, j);
                    });
                });
            }

            const edgeCount = Array.from(adj.values()).reduce((s, arr) => s + arr.length, 0);
            // build quick lookup set map for code edges
            const codeAdjMap = new Map();
            for (let i = 0; i < poles.length; i++) codeAdjMap.set(i, new Set());
            for (const [k, neighbors] of adj.entries()) {
                neighbors.forEach(n => codeAdjMap.get(k).add(n.to));
            }

            if (edgeCount > 0) {
                window.poleAdjacency = adj;
                window.poleCodeAdj = codeAdjMap;
                window.poleAdjacencySource = 'code';
                console.log('🔗 Built pole code adjacency (edges):', edgeCount);
            } else {
                // no code-based edges found
                window.poleAdjacencySource = 'none';
                window.poleAdjacency = new Map();
                window.poleCodeAdj = new Map();
                console.log('⚠️ No code-based pole adjacency found');
            }
        }

        function getNodeCoordinatesSimple(node) {
            if (!node || !node.latlng) return null;
            const m = ('' + node.latlng).match(/-?\d+(?:\.\d+)?/g);
            if (!m || m.length < 2) return null;
            return [parseFloat(m[0]), parseFloat(m[1])];
        }

        // Build proximity adjacency for poles (used as fallback path edges)
        function buildPoleProximityAdj() {
            if (!poles || poles.length === 0) {
                window.poleProximityAdj = new Map();
                return;
            }
            const adj = new Map();
            const connectThresholdKm = 0.08; // ~80m proximity
            for (let i = 0; i < poles.length; i++) adj.set(i, []);
            for (let i = 0; i < poles.length; i++) {
                for (let j = i + 1; j < poles.length; j++) {
                    const di = calculateDistance(poles[i].lat, poles[i].lng, poles[j].lat, poles[j].lng);
                    if (di <= connectThresholdKm) {
                        adj.get(i).push({ to: j, cost: di });
                        adj.get(j).push({ to: i, cost: di });
                    }
                }
            }
            window.poleProximityAdj = adj;
            console.log('🔗 Built pole proximity adjacency (edges):', Array.from(adj.values()).reduce((s, arr) => s + arr.length, 0));
        }


        // Node icons from ./icon/
        const nodeIcons = {
            pop: L.icon({ iconUrl: './icon/pop.gif', iconSize: [10, 10], iconAnchor: [10, 10] }),
            cabinet: L.icon({ iconUrl: './icon/TC_ADSL.gif', iconSize: [10, 10], iconAnchor: [10, 10] }),
            splice: L.icon({ iconUrl: './icon/mangxong.png', iconSize: [10, 10], iconAnchor: [9, 9] }),
            dot: L.divIcon({ html: '<div style="width:10px;height:10px;opacity:.9"></div>', className: '', iconSize: [10, 10], iconAnchor: [5, 5] })
        };


        function classifyNodeType(typeValue) {
            if (typeValue == null) return 'other';
            const num = parseInt(typeValue);
            if (!isNaN(num)) {
                if (num === 1) return 'pop';
                if (num === 2 || num === 3) return 'cabinet';
                if (num === 4) return 'splice';
            }
            const s = ('' + typeValue).toLowerCase();
            if (s === 'g.652d') return 'splice';
            return 'other';
        }

        // Ensure route JSON is loaded (lazy load)
        async function ensureRouteData(rid) {
            if (segsByRoute.has(rid)) return segsByRoute.get(rid);
            const url = `./data/ring/Axis_id=${rid}.json`;
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(resp.statusText || resp.status);
                const j = await resp.json();
                const segs = j.table || [];
                const nds = j.table1 || [];
                segsByRoute.set(rid, segs);
                nodesByRoute.set(rid, nds);
                // also keep an aggregated list of nodes for quick lookup/snapping
                if (Array.isArray(nds) && nds.length) {
                    // normalize numeric node IDs to Number so adjacency lookups match types
                    nds.forEach(n => {
                        if (n && n.id != null) {
                            const num = Number(n.id);
                            if (!Number.isNaN(num)) n.id = num;
                        }
                    });
                    nodes.push(...nds);
                }
                return segs;
            } catch (e) {
                console.warn('Failed to load', url, e && e.message);
                segsByRoute.set(rid, []);
                return [];
            }
        }

        // Draw polylines for currently checked routes
        async function drawSelectedRoutes() {
            try { dataLayer.clearLayers(); } catch (e) { }
            const checked = Array.from(routeCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value);
            const bounds = [];
            for (const rid of checked) {
                const segs = await ensureRouteData(rid);
                segs.forEach(s => {
                    const coords = parseLatLngString(s.latlng);
                    if (!coords || coords.length < 2) return;
                    const pl = L.polyline(coords, { color: '#6a1b9a', weight: 3, opacity: 0.95 });
                    pl.bindTooltip(`${rid} - ${s.name || ''}`);
                    dataLayer.addLayer(pl);
                    coords.forEach(c => bounds.push(c));
                });
                // draw nodes (points) for this route if available
                const nds = nodesByRoute.get(rid) || [];
                nds.forEach(n => {
                    const coord = getNodeCoordinatesSimple(n);
                    if (!coord) return;
                    const cls = classifyNodeType(n.type);
                    const icon = cls === 'pop' ? nodeIcons.pop : (cls === 'cabinet' ? nodeIcons.cabinet : (cls === 'splice' ? nodeIcons.splice : nodeIcons.dot));
                    const marker = L.marker(coord, { title: `${n.name || n.code || n.id} (${cls})`, icon });
                    marker.bindTooltip(`${n.name || n.code || n.id} (${cls})`);
                    marker.bindPopup(`<b>Node</b><br>Name: ${n.name || n.code || n.id}<br>Type: ${cls}<br>Coordinate: ${coord[0].toFixed(6)}, ${coord[1].toFixed(6)}`);
                    dataLayer.addLayer(marker);
                    bounds.push(coord);
                });
            }
            if (bounds.length) try { map.fitBounds(bounds); } catch (e) { }
        }

        // Load location data from getlocation.json
        async function loadLocationData() {
            try {
                const response = await fetch('./data/getlocation.json');
                const data = await response.json();
                const locationMap = new Map();
                (data.Table || []).forEach(loc => {
                    locationMap.set(loc.ID, loc.Name);
                });
                return locationMap;
            } catch (err) {
                console.warn('Failed to load location data:', err);
                return new Map();
            }
        }

        // load route list and pole sets for UI
        async function loadRoutesAndPoles() {
            statusEl.textContent = 'Loading routes...';

            // Load location data first
            const locationMap = await loadLocationData();

            try {
                const r = await fetch('./data/getroute.json');
                const jr = await r.json();
                const entries = (jr && jr.table) ? jr.table : [];
                entries.forEach(e => {
                    const id = e.id;
                    const label = document.createElement('label'); label.style.display = 'block';
                    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = id; cb.id = `route_${id}`; cb.style.marginRight = '6px';

                    // Enhanced display name with location
                    let displayName = `${id} - `;
                    if (e.locationid && locationMap.has(e.locationid)) {
                        displayName += locationMap.get(e.locationid);
                    } else {
                        displayName += e.name || '';
                    }

                    const span = document.createElement('span'); span.textContent = displayName;
                    label.appendChild(cb); label.appendChild(span); routeCheckboxes.appendChild(label);
                    // draw when toggled (lazy-load data)
                    cb.addEventListener('change', drawSelectedRoutes);
                });
                statusEl.textContent = `Loaded ${entries.length} routes`;
            } catch (err) {
                statusEl.textContent = 'Failed loading routes';
            }

            statusEl.textContent = statusEl.textContent + ' · Loading pole sets...';

            // Load pole sources dynamically from index file
            let poleSources = [];
            try {
                const indexResp = await fetch('./data/tru_index.json');
                if (indexResp.ok) {
                    const indexData = await indexResp.json();
                    poleSources = indexData.files || [];
                    console.log(`📋 Loaded ${poleSources.length} pole sources from index`);
                } else {
                    console.warn('tru_index.json not found, using fallback');
                    // Fallback to hardcoded list if index doesn't exist
                    poleSources = [
                        { key: 'Tru_HNI1', url: './data/tru/Tru_HNI1.json' },
                        { key: 'Tru_NAN', url: './data/tru/Tru_NAN.json' }
                    ];
                }
            } catch (e) {
                console.warn('Failed to load tru_index.json:', e);
                // Fallback to hardcoded list
                poleSources = [
                    { key: 'Tru_HNI1', url: './data/tru/Tru_HNI1.json' },
                    { key: 'Tru_NAN', url: './data/tru/Tru_NAN.json' }
                ];
            }

            for (const src of poleSources) {
                try {
                    const resp = await fetch(src.url);
                    const j = await resp.json();
                    const arr = j.table || j.items || j.data || [];
                    const parsed = parsePoleTableArray(arr);
                    poleSetsData.set(src.key, parsed);
                    const label = document.createElement('label'); label.style.display = 'block';
                    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = src.key; cb.id = `poleset_${src.key}`; cb.style.marginRight = '6px';
                    const span = document.createElement('span'); span.textContent = `${src.key} (${parsed.length})`;
                    label.appendChild(cb); label.appendChild(span); poleCheckboxes.appendChild(label);
                    cb.addEventListener('change', rebuildPolesFromSelection);
                } catch (e) {
                    const label = document.createElement('div'); label.textContent = `${src.key}: error`; poleCheckboxes.appendChild(label);
                }
            }
            // attach select/clear handlers to redraw
            document.getElementById('selectAllRoutes').addEventListener('click', () => { Array.from(routeCheckboxes.querySelectorAll('input')).forEach(i => i.checked = true); drawSelectedRoutes(); });
            document.getElementById('clearAllRoutes').addEventListener('click', () => { Array.from(routeCheckboxes.querySelectorAll('input')).forEach(i => i.checked = false); drawSelectedRoutes(); });
            document.getElementById('selectAllPolesets').addEventListener('click', () => { Array.from(poleCheckboxes.querySelectorAll('input')).forEach(i => i.checked = true); rebuildPolesFromSelection(); });
            document.getElementById('clearAllPolesets').addEventListener('click', () => { Array.from(poleCheckboxes.querySelectorAll('input')).forEach(i => i.checked = false); rebuildPolesFromSelection(); });
            // Load cot trung the manifest (optional)
            try { loadCotTrungManifest(); } catch (e) { console.warn('loadCotTrungManifest failed', e); }
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadRoutesAndPoles();
            document.getElementById('selectAllRoutes').addEventListener('click', () => { Array.from(routeCheckboxes.querySelectorAll('input')).forEach(i => i.checked = true); drawSelectedRoutes(); });
            document.getElementById('clearAllRoutes').addEventListener('click', () => { Array.from(routeCheckboxes.querySelectorAll('input')).forEach(i => i.checked = false); drawSelectedRoutes(); });
            document.getElementById('selectAllPolesets').addEventListener('click', () => { Array.from(poleCheckboxes.querySelectorAll('input')).forEach(i => i.checked = true); rebuildPolesFromSelection(); });
            document.getElementById('clearAllPolesets').addEventListener('click', () => { Array.from(poleCheckboxes.querySelectorAll('input')).forEach(i => i.checked = false); rebuildPolesFromSelection(); });
        });

        // Show candidates button (trigger modal for current start/end)
        const showCandidatesBtn = document.getElementById('showCandidatesBtn');
        if (showCandidatesBtn) {
            showCandidatesBtn.addEventListener('click', async () => {
                if (!startPointCoords || !endPointCoords) {
                    alert('Vui lòng chọn điểm đầu và điểm cuối trước (📍 Lấy tọa độ).');
                    return;
                }
                // If we have cached top results, show them; otherwise recompute
                if (window.__lastTopResults && window.__lastTopResults.length) {
                    renderTopResults(window.__lastTopResults);
                    return;
                }
                try {
                    // attempt to recompute using existing selected routes/poles
                    await findAndDrawNetworkPaths();
                } catch (e) { }
                if (window.__lastTopResults && window.__lastTopResults.length) {
                    renderTopResults(window.__lastTopResults);
                } else {
                    alert('Không có kết quả nào. Vui lòng kiểm tra các tuyến đã chọn.');
                }
            });
        }
        // Coordinate button behaviour
        const coordBtn = document.getElementById('getCoordinatesBtn');
        const clearBtn = document.getElementById('clearClickMarker');
        if (coordBtn) {
            coordBtn.addEventListener('click', async () => {
                if (!isCoordinateMode) {
                    // Ensure nodes for all routes are loaded so nearby POPs can be found/snapped
                    try {
                        statusEl.textContent = 'Loading nodes for routes...';
                        await ensureAllRoutesLoaded();
                    } catch (e) {
                        console.warn('ensureAllRoutesLoaded failed', e);
                    } finally {
                        statusEl.textContent = '';
                    }
                    // enter coordinate mode (do NOT hide poles)
                    isCoordinateMode = true;
                    coordBtn.textContent = '✅ Click vào bản đồ để chọn';
                    coordBtn.style.background = '#dc3545';
                } else {
                    // cancel mode
                    isCoordinateMode = false;
                    coordBtn.textContent = '📍 Lấy tọa độ';
                    coordBtn.style.background = '#28a745';
                }
            });
        }
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                try { if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; } } catch (e) { }
                try { if (startPointMarker) { map.removeLayer(startPointMarker); startPointMarker = null; } } catch (e) { }
                try { if (endPointMarker) { map.removeLayer(endPointMarker); endPointMarker = null; } } catch (e) { }
                try { nearbyLayer.clearLayers(); nearbyStartLayer.clearLayers(); nearbyEndLayer.clearLayers(); } catch (e) { }
                try { walkingRoutesLayer.clearLayers(); } catch (e) { }
                try { routeLabelsLayer.clearLayers(); } catch (e) { }
                startPointCoords = null; endPointCoords = null;
                isCoordinateMode = false; coordinateModeType = 'start';
                if (coordBtn) { coordBtn.textContent = '📍 Lấy tọa độ'; coordBtn.style.background = '#28a745'; }
            });
        }

        // map click to pick coordinate (supports start and end)
        map.on('click', function (e) {
            if (!isCoordinateMode) return;
            const lat = e.latlng.lat;
            const lng = e.latlng.lng;
            // if picking start
            if (coordinateModeType === 'start' || coordinateModeType === 'end') {
                handleCoordinatePick(lat, lng, coordinateModeType);
                return;
            }
        });

        // Ensure all route data (nodes) loaded (used when enabling coordinate mode)
        async function ensureAllRoutesLoaded() {
            const inputs = Array.from(routeCheckboxes.querySelectorAll('input'));
            const promises = inputs.map(i => ensureRouteData(i.value).catch(() => { }));
            await Promise.all(promises);
            try {
                normalizeNodeIdsAcrossSegments();
            } catch (e) { console.warn('normalizeNodeIdsAcrossSegments failed', e); }
        }

        // Normalize/match missing node IDs referenced in segments to canonical node IDs from loaded nodes
        function normalizeNodeIdsAcrossSegments() {
            nodeIdMap = new Map();
            // collect all segments
            const segments = [];
            for (const segs of segsByRoute.values()) segments.push(...(segs || []));

            const canonicalNodeIds = new Set(nodes.map(n => n.id));
            const coordinateToNodeId = new Map();
            const nameToNodeId = new Map();

            // build coordinate/name -> node ID maps
            nodes.forEach(n => {
                if (n.latlng) {
                    const coords = getNodeCoordinatesSimple(n);
                    if (coords) {
                        const key = `${coords[0].toFixed(6)},${coords[1].toFixed(6)}`;
                        coordinateToNodeId.set(key, n.id);
                    }
                }
                const rawName = (n.name || n.code || '').toString();
                if (rawName) {
                    const norm = rawName.replace(/\s+/g, '').replace(/\.\d+.*/, '').toUpperCase();
                    if (norm) nameToNodeId.set(norm, n.id);
                }
            });

            const missingNodeIds = new Set();
            segments.forEach(s => {
                if (s.startdeviceid && !canonicalNodeIds.has(s.startdeviceid)) missingNodeIds.add(s.startdeviceid);
                if (s.enddeviceid && !canonicalNodeIds.has(s.enddeviceid)) missingNodeIds.add(s.enddeviceid);
            });

            // try coordinate/name based mapping
            missingNodeIds.forEach(missingId => {
                segments.forEach(s => {
                    if (s.startdeviceid === missingId || s.enddeviceid === missingId) {
                        if (s.latlng) {
                            const coords = parseLatLngString(s.latlng);
                            if (coords.length > 0) {
                                const startKey = `${coords[0][0].toFixed(6)},${coords[0][1].toFixed(6)}`;
                                const endKey = `${coords[coords.length - 1][0].toFixed(6)},${coords[coords.length - 1][1].toFixed(6)}`;
                                let matchedId = null;
                                if (s.startdeviceid === missingId && coordinateToNodeId.has(startKey)) {
                                    matchedId = coordinateToNodeId.get(startKey);
                                } else if (s.enddeviceid === missingId && coordinateToNodeId.has(endKey)) {
                                    matchedId = coordinateToNodeId.get(endKey);
                                }
                                if (matchedId && !nodeIdMap.has(missingId)) {
                                    nodeIdMap.set(missingId, matchedId);
                                }
                            }
                        }

                        // name-based fallback
                        const startName = (s.startdevicename || '').toString();
                        const endName = (s.enddevicename || '').toString();
                        const normalizeName = (str) => str.replace(/\s+/g, '').replace(/\.\d+.*/, '').toUpperCase();
                        let nameMatchedId = null;
                        if (s.startdeviceid === missingId && startName) {
                            const norm = normalizeName(startName);
                            if (nameToNodeId.has(norm)) nameMatchedId = nameToNodeId.get(norm);
                        }
                        if (s.enddeviceid === missingId && endName) {
                            const norm = normalizeName(endName);
                            if (nameToNodeId.has(norm)) nameMatchedId = nameToNodeId.get(norm);
                        }
                        if (nameMatchedId && !nodeIdMap.has(missingId)) {
                            nodeIdMap.set(missingId, nameMatchedId);
                        }
                    }
                });
            });

            // apply mappings to segments
            segments.forEach(s => {
                if (s.startdeviceid && nodeIdMap.has(s.startdeviceid)) s.startdeviceid = nodeIdMap.get(s.startdeviceid);
                if (s.enddeviceid && nodeIdMap.has(s.enddeviceid)) s.enddeviceid = nodeIdMap.get(s.enddeviceid);
            });

            if (nodeIdMap.size) console.log('Mapped missing node IDs:', nodeIdMap.size);
        }

        // Find nearby nodes/poles within radiusKm
        // Normalize candidate id (Number when possible) and include nodeType and routeId
        function findNearbyPoints(lat, lng, radiusKm) {
            const out = [];
            const seen = new Set();
            // collect nodes from nodesByRoute
            for (const [rid, nds] of nodesByRoute.entries()) {
                (nds || []).forEach(n => {
                    if (!n || (n.id == null)) return;
                    // normalize id to Number when possible to match adjacency keys
                    let parsedId = n.id;
                    const num = Number(n.id);
                    if (!Number.isNaN(num)) parsedId = num;
                    const dedupeKey = `n:${rid}:${parsedId}`;
                    if (seen.has(dedupeKey)) return;
                    const c = getNodeCoordinatesSimple(n);
                    if (!c) return;
                    const d = calculateDistance(lat, lng, c[0], c[1]);
                    if (d <= radiusKm) {
                        out.push({ type: 'node', id: parsedId, name: n.name || n.code || '', lat: c[0], lng: c[1], dist: d, routeId: rid, nodeType: n.type });
                        seen.add(dedupeKey);
                    }
                });
            }
            // (do not include poles here) -- search only nodes
            // sort by distance (POP preference handled elsewhere)
            out.sort((a, b) => a.dist - b.dist);
            return out;
        }

        // Helper function to find nearby candidates with fallback to all loaded nodes
        // Returns candidates array (may be empty if no nodes found)
        function findNearbyCandidatesWithFallback(lat, lng, radiusKm) {
            let candidates = findNearbyPoints(lat, lng, radiusKm);

            // fallback: if no nearby candidates found, include nodes from aggregated `nodes` within same radius
            if (!candidates || candidates.length === 0) {
                const fallback = [];
                for (const n of nodes) {
                    if (!n || !n.latlng) continue;
                    const c = getNodeCoordinatesSimple(n);
                    if (!c) continue;
                    const d = calculateDistance(lat, lng, c[0], c[1]);
                    if (d <= radiusKm) {
                        fallback.push({ type: 'node', id: n.id, name: n.name || n.code || '', lat: c[0], lng: c[1], dist: d, routeId: null, nodeType: n.type });
                    }
                }
                if (fallback.length) {
                    fallback.sort((a, b) => a.dist - b.dist);
                    // merge unique ids into candidates
                    const seen = new Set((candidates || []).map(x => x.id));
                    fallback.forEach(f => { if (!seen.has(f.id)) { candidates.push(f); seen.add(f.id); } });
                }
            }

            return candidates;
        }

        // Unified handler for picking start/end coordinates
        function handleCoordinatePick(lat, lng, type) {
            const radiusKm = 0.5;
            if (type === 'start') {
                try { if (startPointMarker) map.removeLayer(startPointMarker); } catch (e) { }
                startPointCoords = [lat, lng];
                startPointMarker = L.marker([lat, lng], { title: 'Start point' }).addTo(map);
                startPointMarker.bindPopup(`<div style="font-family:monospace"><b>Start</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}</div>`).openPopup();

                // Use helper function with fallback
                try { nearbyLayer.clearLayers(); nearbyStartLayer.clearLayers(); nearbyEndLayer.clearLayers(); } catch (err) { }
                startNearbyCandidates = findNearbyCandidatesWithFallback(lat, lng, radiusKm);
                renderNearbyPointsOnLayer(nearbyStartLayer, startNearbyCandidates, [lat, lng], radiusKm, '#1e90ff', false, false);

                // do not draw connections to poles while in coordinate (point search) mode
                try { nearbyPoleStartLayer.clearLayers(); } catch (e) { }
                coordinateModeType = 'end';
                if (coordBtn) { coordBtn.textContent = '🎯 Click chọn điểm cuối'; coordBtn.style.background = '#ffc107'; }
                return;
            }
            if (type === 'end') {
                try { if (endPointMarker) map.removeLayer(endPointMarker); } catch (e) { }
                endPointCoords = [lat, lng];
                endPointMarker = L.marker([lat, lng], { title: 'End point' }).addTo(map);
                endPointMarker.bindPopup(`<div style="font-family:monospace"><b>End</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}</div>`).openPopup();

                // Use helper function with fallback
                try { nearbyEndLayer.clearLayers(); } catch (err) { }
                endNearbyCandidates = findNearbyCandidatesWithFallback(lat, lng, radiusKm);
                renderNearbyPointsOnLayer(nearbyEndLayer, endNearbyCandidates, [lat, lng], radiusKm, '#28a745', false, false);

                // compute and draw network paths
                try { findAndDrawNetworkPaths(); } catch (e) { console.warn('findAndDrawNetworkPaths failed', e); }
                isCoordinateMode = false;
                coordinateModeType = 'start';
                if (coordBtn) { coordBtn.textContent = '📍 Lấy tọa độ'; coordBtn.style.background = '#28a745'; }
                return;
            }
        }
        function renderNearbyPoints(list, centerLatLng, radiusKm) {
            try { nearbyLayer.clearLayers(); } catch (e) { }
            // do not show the search radius ring when rendering nearby points
            renderNearbyPointsOnLayer(nearbyLayer, list, centerLatLng, radiusKm, '#007bff', false, false);
        }

        function renderNearbyPointsOnLayer(layer, list, centerLatLng, radiusKm, color, showRing = true, drawLines = true) {
            try { layer.clearLayers(); } catch (e) { }
            if (!list || list.length === 0) {
                if (showRing) {
                    const circ = L.circle(centerLatLng, { radius: radiusKm * 1000, color: color || '#007bff', weight: 1, fill: false, opacity: 0.5 });
                    layer.addLayer(circ);
                }
                return;
            }
            if (showRing) {
                const circ = L.circle(centerLatLng, { radius: radiusKm * 1000, color: color || '#007bff', weight: 1, fill: false, opacity: 0.5 });
                layer.addLayer(circ);
            }
            list.forEach(p => {
                const stroke = color || (p.type === 'node' ? '#1e90ff' : '#ff8c00');
                if (drawLines) {
                    const line = L.polyline([centerLatLng, [p.lat, p.lng]], { color: stroke, weight: 1.5, opacity: 0.9, dashArray: '4,6' });
                    layer.addLayer(line);
                }
                const mk = L.circleMarker([p.lat, p.lng], { radius: 4, color: stroke, weight: 1, fillColor: stroke, fillOpacity: 0.95 });
                mk.bindTooltip(`${p.type.toUpperCase()}: ${p.name || p.code || p.id} (${(p.dist * 1000).toFixed(0)} m)`);
                layer.addLayer(mk);
            });
        }

        // Find nearby poles within radiusKm
        function findNearbyPoles(lat, lng, radiusKm) {
            const out = [];
            if (!poles || poles.length === 0) return out;
            poles.forEach(p => {
                if (!p) return;
                const d = calculateDistance(lat, lng, p.lat, p.lng);
                if (d <= radiusKm) out.push(Object.assign({ dist: d }, p));
            });
            out.sort((a, b) => a.dist - b.dist);
            return out;
        }

        function renderNearbyPolesOnLayer(layer, list, centerLatLng, radiusKm) {
            try { layer.clearLayers(); } catch (e) { }
            if (!list || list.length === 0) {
                return;
            }
            list.forEach(p => {
                const line = L.polyline([centerLatLng, [p.lat, p.lng]], { color: '#ff8c00', weight: 2, opacity: 0.9, dashArray: '6,6' });
                layer.addLayer(line);
                const mk = L.circleMarker([p.lat, p.lng], { radius: 4, color: '#ff8c00', weight: 1, fillColor: '#ffd1a3', fillOpacity: 0.95 });
                mk.bindTooltip(`${p.code || p.id || p.name} (${(p.dist * 1000).toFixed(0)} m)`);
                mk.on && mk.on('click', () => {
                    // do not draw connectors while in coordinate (point-search) mode
                    if (isCoordinateMode) return;
                    // draw route from startPoint to this pole as simple straight connector (visual aid)
                    try { walkingRoutesLayer.clearLayers(); } catch (e) { }
                    walkingRoutesLayer.addLayer(L.polyline([centerLatLng, [p.lat, p.lng]], { color: '#1e90ff', weight: 4, opacity: 0.9 }));
                });
                layer.addLayer(mk);
            });
        }

        // Build adjacency map (undirected) from selected routes' segments
        function buildAdjacencyForSelectedRoutes() {
            const checked = Array.from(routeCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value);
            const adjacency = new Map(); // nodeId -> Set(nodeId)
            function addEdge(a, b) { if (!adjacency.has(a)) adjacency.set(a, new Set()); if (!adjacency.has(b)) adjacency.set(b, new Set()); adjacency.get(a).add(b); adjacency.get(b).add(a); }
            for (const rid of checked) {
                const segs = segsByRoute.get(rid) || [];
                segs.forEach(s => {
                    const a = s.startdeviceid; const b = s.enddeviceid;
                    if (a != null && b != null) addEdge(a, b);
                });
            }
            return adjacency;
        }

        function buildEdgeGeometryMap() {
            const checked = Array.from(routeCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value);
            const edgeMap = new Map(); // key a-b -> coords
            for (const rid of checked) {
                const segs = segsByRoute.get(rid) || [];
                segs.forEach(s => {
                    const a = s.startdeviceid; const b = s.enddeviceid;
                    if (a == null || b == null) return;
                    const coords = parseLatLngString(s.latlng);
                    if (!coords || coords.length === 0) return;
                    edgeMap.set(`${a}-${b}`, coords);
                    edgeMap.set(`${b}-${a}`, coords.slice().reverse());
                });
            }
            return edgeMap;
        }

        // Dijkstra shortest path (weights = polyline length km)
        function computeShortestNetworkPath(startId, endId, adjacency, edgeMap) {
            if (!adjacency || !edgeMap) return false;
            const dist = new Map(); const prev = new Map(); const visited = new Set();
            const nodesIds = Array.from(adjacency.keys()); nodesIds.forEach(id => dist.set(id, Infinity));
            if (!dist.has(startId)) return false; dist.set(startId, 0);
            function extractMin() { let best = null, bestD = Infinity; for (const id of nodesIds) { if (visited.has(id)) continue; const d = dist.get(id); if (d < bestD) { bestD = d; best = id; } } return best; }
            while (true) { const u = extractMin(); if (u == null) break; if (u === endId) break; visited.add(u); const nexts = adjacency.get(u); if (!nexts) continue; for (const v of nexts) { const coords = edgeMap.get(`${u}-${v}`); if (!coords || coords.length < 2) continue; let w = 0; for (let i = 1; i < coords.length; i++) { w += calculateDistance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]); } const alt = dist.get(u) + w; if (alt < dist.get(v)) { dist.set(v, alt); prev.set(v, u); } } }
            if (!prev.has(endId) && startId !== endId) return false;
            const path = [endId]; let cur = endId; while (cur !== startId) { const p = prev.get(cur); if (p == null) break; path.push(p); cur = p; } path.reverse();
            let totalKm = 0; for (let i = 0; i < path.length - 1; i++) { const a = path[i], b = path[i + 1]; const coords = edgeMap.get(`${a}-${b}`); if (coords && coords.length) { for (let j = 1; j < coords.length; j++) { totalKm += calculateDistance(coords[j - 1][0], coords[j - 1][1], coords[j][0], coords[j][1]); } } }
            return { km: totalKm, path };
        }

        function drawWeightedNetworkPathBetweenNodes(startId, endId, adjacency, edgeMap, options = {}) {
            if (!adjacency || !edgeMap) return false;
            const color = options.color || '#007f0e';
            const weight = options.weight || 6;
            const opacity = (typeof options.opacity === 'number') ? options.opacity : 0.95;
            const res = computeShortestNetworkPath(startId, endId, adjacency, edgeMap);
            if (!res) return false;
            const grp = L.layerGroup();
            const path = res.path;
            const totalKm = res.km || 0;
            // draw each edge segment without per-segment tooltips
            for (let i = 0; i < path.length - 1; i++) {
                const a = path[i], b = path[i + 1];
                const coords = edgeMap.get(`${a}-${b}`);
                if (!coords || coords.length < 2) continue;
                const pl = L.polyline(coords, { color, weight, opacity });
                grp.addLayer(pl);
            }
            return { km: totalKm, grp };
        }

        // compute midpoint (lat,lng) along full path (array of node ids) using edgeMap geometries
        function getPolylineMidpoint(edgeMap, path) {
            if (!path || path.length < 2) return null;
            // build full coords array
            const coords = [];
            for (let i = 0; i < path.length - 1; i++) {
                const seg = edgeMap.get(`${path[i]}-${path[i + 1]}`);
                if (!seg || seg.length === 0) continue;
                // append, avoid duplicate vertex
                if (coords.length === 0) coords.push(...seg);
                else coords.push(...seg.slice(1));
            }
            if (coords.length === 0) return null;
            // compute cumulative lengths
            let total = 0; const lens = [0];
            for (let i = 1; i < coords.length; i++) { const a = coords[i - 1]; const b = coords[i]; const d = calculateDistance(a[0], a[1], b[0], b[1]); total += d; lens.push(total); }
            const half = total / 2;
            for (let i = 1; i < lens.length; i++) { if (lens[i] >= half) { const a = coords[i - 1]; const b = coords[i]; const prev = lens[i - 1]; const segLen = lens[i] - prev; const t = segLen === 0 ? 0 : (half - prev) / segLen; const lat = a[0] + (b[0] - a[0]) * t; const lng = a[1] + (b[1] - a[1]) * t; return [lat, lng]; } }
            // fallback last
            const last = coords[coords.length - 1]; return [last[0], last[1]];
        }

        // Pick nearest candidate with POP preference (similar to map_data.html behavior)
        function pickNearestCandidate(candidates, preferPop = true) {
            if (!candidates || candidates.length === 0) return null;
            let best = null; // nearest any type
            let bestPop = null; // nearest POP (nodeType === 1)
            candidates.forEach(c => {
                if (!c) return;
                if (!best || c.dist < best.dist) best = c;
                if (c.nodeType === 1 && (!bestPop || c.dist < bestPop.dist)) bestPop = c;
            });
            if (!preferPop) return best;
            const preferWithinKm = 1.0; // same heuristic as map_data
            const popVsNearestFactor = 1.5;
            if (bestPop) {
                if (!best || bestPop.dist <= preferWithinKm || bestPop.dist <= (best.dist * popVsNearestFactor)) {
                    return bestPop;
                }
            }
            return best;
        }

        // layer for route labels/popups
        const routeLabelsLayer = L.layerGroup().addTo(map);

        async function findAndDrawNetworkPaths() {
            if (!startNearbyCandidates || !endNearbyCandidates || startNearbyCandidates.length === 0 || endNearbyCandidates.length === 0) return;
            const adjacency = buildAdjacencyForSelectedRoutes();
            const edgeMap = buildEdgeGeometryMap();

            // Helper: find nearest node id that exists in adjacency (by geographic distance)
            function nearestAdjNodeId(lat, lng, adjacencyMap) {
                let best = null; let bestD = Infinity;
                for (const id of adjacencyMap.keys()) {
                    // find node object with this id
                    const nodeObj = nodes.find(n => n.id === id);
                    if (!nodeObj || !nodeObj.latlng) continue;
                    const c = getNodeCoordinatesSimple(nodeObj);
                    if (!c) continue;
                    const d = calculateDistance(lat, lng, c[0], c[1]);
                    if (d < bestD) { bestD = d; best = id; }
                }
                return best;
            }

            try { walkingRoutesLayer.clearLayers(); } catch (eClear) { walkingRoutesLayer = L.layerGroup().addTo(map); }

            // Build candidate lists (top N nearest) for start and end, prioritizing nearby candidates then adjacency nodes
            const MAX_CANDIDATES = 5;
            const sCoords = startPointCoords || (startNearbyCandidates[0] ? [startNearbyCandidates[0].lat, startNearbyCandidates[0].lng] : null);
            const eCoords = endPointCoords || (endNearbyCandidates[0] ? [endNearbyCandidates[0].lat, endNearbyCandidates[0].lng] : null);

            function uniqueById(arr) {
                const seen = new Set(); const out = [];
                arr.forEach(a => { if (!a) return; const id = a.id; if (id == null) return; if (!seen.has(id)) { seen.add(id); out.push(a); } });
                return out;
            }

            // gather top nearest from nearbyCandidate lists
            // do not limit nearby candidates — take all found within radius
            let startCandidates = (startNearbyCandidates || []).slice();
            let endCandidates = (endNearbyCandidates || []).slice();

            // include nearest adjacency nodes (by geographic distance) to expand candidates
            const adjStarts = [];
            const adjEnds = [];
            for (const id of adjacency.keys()) {
                const nodeObj = nodes.find(n => n.id === id);
                if (!nodeObj || !nodeObj.latlng) continue;
                const c = getNodeCoordinatesSimple(nodeObj);
                if (!c) continue;
                if (sCoords) {
                    const ds = calculateDistance(sCoords[0], sCoords[1], c[0], c[1]);
                    // only include adjacency nodes within a sensible radius to avoid explosion
                    if (ds <= 0.5) adjStarts.push({ id: nodeObj.id, name: nodeObj.name || nodeObj.code || '', lat: c[0], lng: c[1], dist: ds, nodeType: nodeObj.type });
                }
                if (eCoords) {
                    const de = calculateDistance(eCoords[0], eCoords[1], c[0], c[1]);
                    if (de <= 0.5) adjEnds.push({ id: nodeObj.id, name: nodeObj.name || nodeObj.code || '', lat: c[0], lng: c[1], dist: de, nodeType: nodeObj.type });
                }
            }
            adjStarts.sort((a, b) => a.dist - b.dist);
            adjEnds.sort((a, b) => a.dist - b.dist);
            // include adjacency nodes (filtered by radius)
            startCandidates = uniqueById(startCandidates.concat(adjStarts));
            endCandidates = uniqueById(endCandidates.concat(adjEnds));

            // If candidate pairs explode, trim to nearest 10 on each side to keep computation bounded
            const PAIR_LIMIT = 200;
            if ((startCandidates.length * endCandidates.length) > PAIR_LIMIT) {
                startCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
                endCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
                startCandidates = startCandidates.slice(0, 10);
                endCandidates = endCandidates.slice(0, 10);
            }

            if (!startCandidates.length || !endCandidates.length) { console.log('No start/end candidates after expansion'); return; }

            // Evaluate all pairs and collect results, then pick top candidates
            const allResults = [];
            for (const sc of startCandidates) {
                for (const ec of endCandidates) {
                    if (!sc || !ec || sc.id == null || ec.id == null) continue;
                    const netRes = computeShortestNetworkPath(sc.id, ec.id, adjacency, edgeMap);
                    if (!netRes) continue;
                    const networkKm = netRes.km || Infinity;
                    allResults.push({ networkKm, startNode: sc, endNode: ec, networkRes: netRes });
                }
            }
            if (!allResults.length) { console.log('No network path found among candidates'); return; }
            // sort by network distance and pick top 5
            allResults.sort((a, b) => a.networkKm - b.networkKm);
            const topResults = allResults.slice(0, 10);
            const best = topResults[0];

            // draw the best network path
            const resBest = drawWeightedNetworkPathBetweenNodes(best.startNode.id, best.endNode.id, adjacency, edgeMap, { color: '#28a745', weight: 8, opacity: 0.95 });
            if (resBest && resBest.grp) {
                walkingRoutesLayer.addLayer(resBest.grp);
                // attach click handler on drawn polylines to reopen top-results modal
                try {
                    resBest.grp.eachLayer(layer => {
                        try {
                            layer.on && layer.on('click', () => {
                                try { renderTopResults(window.__lastTopResults || topResults); } catch (e) { }
                            });
                        } catch (e) { }
                    });
                } catch (e) { }

                // Attempt to draw walking legs from startPoint -> startNode and endNode -> endPoint using poles-first logic
                try {
                    let leg1 = null;
                    let leg2 = null;
                    if (startPointCoords && best && best.startNode) {
                        console.log('Debug: attempting walking leg from startPoint to startNode', { startPointCoords, startNode: best.startNode, polesCount: poles.length });
                        try { leg1 = await routeViaPolesToNode(startPointCoords[0], startPointCoords[1], best.startNode.id); } catch (e) { console.warn('routeViaPolesToNode failed', e); }
                        if (!leg1) {
                            try { leg1 = await routeViaPolesWalk(startPointCoords[0], startPointCoords[1], best.startNode.lat, best.startNode.lng, { computeOnly: false }); } catch (e) { console.warn('routeViaPolesWalk failed', e); }
                        }
                        if (!leg1) {
                            try { leg1 = await chooseBestWalkingLeg(startPointCoords[0], startPointCoords[1], best.startNode.lat, best.startNode.lng, { color: '#1e90ff' }); } catch (e) { console.warn('chooseBestWalkingLeg failed', e); }
                        }
                        console.log('Debug: leg1 result', leg1);
                        // Only draw fallback straight connector if NO pole-based drawing occurred
                        if (!leg1 || !leg1.drawn) {
                            try {
                                const sx = startPointCoords[0], sy = startPointCoords[1];
                                const tx = (best.startNode.lat != null) ? best.startNode.lat : null;
                                const ty = (best.startNode.lng != null) ? best.startNode.lng : null;
                                if ((tx !== null) && (ty !== null)) {
                                    const fallbackLine = L.polyline([[sx, sy], [tx, ty]], { color: '#1e90ff', weight: 6, opacity: 0.9, dashArray: '2,6' });
                                    walkingRoutesLayer.addLayer(fallbackLine);
                                    console.log('Debug: drew fallback straight connector for leg1');
                                }
                            } catch (errFb) { console.warn('fallback draw leg1 failed', errFb); }
                        }
                    }
                    if (endPointCoords && best && best.endNode) {
                        console.log('Debug: attempting walking leg from endNode to endPoint', { endPointCoords, endNode: best.endNode, polesCount: poles.length });
                        try { leg2 = await routeViaPolesToNode(endPointCoords[0], endPointCoords[1], best.endNode.id); } catch (e) { console.warn('routeViaPolesToNode(end) failed', e); }
                        if (!leg2) {
                            try { leg2 = await routeViaPolesWalk(endPointCoords[0], endPointCoords[1], best.endNode.lat, best.endNode.lng, { computeOnly: false }); } catch (e) { console.warn('routeViaPolesWalk(end) failed', e); }
                        }
                        if (!leg2) {
                            try { leg2 = await chooseBestWalkingLeg(endPointCoords[0], endPointCoords[1], best.endNode.lat, best.endNode.lng, { color: '#1e90ff', clipToEnd: true }); } catch (e) { console.warn('chooseBestWalkingLeg(end) failed', e); }
                        }
                        console.log('Debug: leg2 result', leg2);
                        // Only draw fallback straight connector if NO pole-based drawing occurred
                        if (!leg2 || !leg2.drawn) {
                            try {
                                const tx = endPointCoords[0], ty = endPointCoords[1];
                                const sx = (best.endNode.lat != null) ? best.endNode.lat : null;
                                const sy = (best.endNode.lng != null) ? best.endNode.lng : null;
                                if ((sx !== null) && (sy !== null)) {
                                    const fallbackLine2 = L.polyline([[sx, sy], [tx, ty]], { color: '#1e90ff', weight: 6, opacity: 0.9, dashArray: '2,6' });
                                    walkingRoutesLayer.addLayer(fallbackLine2);
                                    console.log('Debug: drew fallback straight connector for leg2');
                                }
                            } catch (errFb) { console.warn('fallback draw leg2 failed', errFb); }
                        }
                    }

                    // render interactive top results table
                    try {
                        // save for later interactions
                        window.__lastTopResults = topResults;
                        window.__lastEdgeMap = edgeMap;
                        window.__lastAdjacency = adjacency;
                        renderTopResults(topResults);
                    } catch (e) { }

                    // show popup summarizing legs + network km
                    const walkingKm1 = (typeof leg1 === 'object' && leg1 && Number.isFinite(leg1.km)) ? leg1.km : 0;
                    const walkingKm2 = (typeof leg2 === 'object' && leg2 && Number.isFinite(leg2.km)) ? leg2.km : 0;
                    const totalKm = walkingKm1 + (best.networkKm || 0) + walkingKm2;
                    if (endPointMarker) endPointMarker.bindPopup(`<b>Best network path</b><br>Walking leg 1: ${walkingKm1.toFixed(3)} km<br>Network: ${(best.networkKm || 0).toFixed(3)} km<br>Walking leg 2: ${walkingKm2.toFixed(3)} km<br><b>Total: ${totalKm.toFixed(3)} km</b>`).openPopup();
                } catch (errLeg) {
                    // fallback: just save results and popup network-only
                    try {
                        window.__lastTopResults = topResults;
                        window.__lastEdgeMap = edgeMap;
                        window.__lastAdjacency = adjacency;
                        renderTopResults(topResults);
                    } catch (e) { }
                    if (endPointMarker) endPointMarker.bindPopup(`<b>Best network path</b><br>Distance: ${best.networkKm.toFixed(3)} km`).openPopup();
                }
            }
        }

        // Collapse/expand sidebar menu
        (function () {
            const collapseBtn = document.getElementById('collapseBtn');
            const sidebarEl = document.getElementById('sidebar');
            const sidebarHandle = document.getElementById('sidebarHandle');
            if (!collapseBtn || !sidebarEl) return;
            // collapse into fully hidden sidebar
            collapseBtn.addEventListener('click', () => {
                // hide sidebar completely and show small handle
                sidebarEl.style.display = 'none';
                if (sidebarHandle) sidebarHandle.style.display = 'block';
            });
            // handle to reopen
            if (sidebarHandle) {
                sidebarHandle.addEventListener('click', () => {
                    sidebarEl.style.display = '';
                    sidebarHandle.style.display = 'none';
                });
            }
        })();

        function rebuildPolesFromSelection() {
            poles = [];
            for (const key of poleSetsData.keys()) {
                const cb = document.getElementById(`poleset_${key}`);
                if (cb && cb.checked) poles.push(...(poleSetsData.get(key) || []));
            }
            polesLayer.clearLayers();
            poles.forEach(p => {
                const mk = L.circleMarker([p.lat, p.lng], { radius: 3, color: '#ff8c00', weight: 1, fillColor: '#ffd1a3', fillOpacity: 0.95 });
                mk.bindTooltip(`${p.code || p.id || p.name}`);
                mk.bindPopup(`<b>Pole</b><br>Code: ${p.code || p.id}<br>Type: ${p.type}<br>Coordinate: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
                polesLayer.addLayer(mk);
            });
            // draw links between poles after rendering markers
            try { drawAllPoleLinks(); } catch (e) { console.warn('drawAllPoleLinks failed', e); }
            try { buildPoleCodeAdjacency(); } catch (e) { console.warn('buildPoleCodeAdjacency failed', e); }
        }

        // Render top results into modal table and show it
        function renderTopResults(results) {
            const body = document.getElementById('topResultsModalBody');
            const modal = document.getElementById('topResultsModal');
            if (!body || !modal) return;
            if (!results || results.length === 0) { body.innerHTML = '<div>No candidates</div>'; modal.style.display = 'none'; return; }
            let html = '<table style="width:100%;border-collapse:collapse;">';
            html += '<tr style="font-weight:bold;background:#f0f0f0;"><td style="width:30px">#</td><td>Điểm đầu</td><td>Tuyến</td><td>Điểm cuối</td><td style="width:120px;text-align:center">Số POPs trung gian</td><td style="width:90px;text-align:right">Km</td><td style="width:120px">Hành động</td></tr>';
            results.forEach((r, idx) => {
                const sname = (r.startNode && (r.startNode.name || r.startNode.id)) || '';
                const ename = (r.endNode && (r.endNode.name || r.endNode.id)) || '';
                const routes = getRouteNamesForPath(r.networkRes && r.networkRes.path) || [];
                // compute POPs and cabinets count along the network path (exclude start/end if desired? include intermediates)
                let popCabCount = 0;
                try {
                    const pathIds = (r.networkRes && r.networkRes.path) ? r.networkRes.path : [];
                    for (let i = 0; i < pathIds.length; i++) {
                        const pid = pathIds[i];
                        const nodeObj = nodes.find(n => n.id === pid);
                        if (!nodeObj) continue;
                        const cls = classifyNodeType(nodeObj.type);
                        if (cls === 'pop' || cls === 'cabinet') popCabCount++;
                    }
                } catch (e) { popCabCount = 0; }
                html += '<tr style="border-top:1px solid #eee;">' +
                    `<td style="padding:6px;vertical-align:middle">${idx + 1}</td>` +
                    `<td style="padding:6px;vertical-align:middle">${escapeHtml(sname)}</td>` +
                    `<td style="padding:6px;vertical-align:middle">${escapeHtml((routes.join(', ')).toString())}</td>` +
                    `<td style="padding:6px;vertical-align:middle">${escapeHtml(ename)}</td>` +
                    `<td style="padding:6px;text-align:center;vertical-align:middle">${popCabCount}</td>` +
                    `<td style="padding:6px;text-align:right;vertical-align:middle">${r.networkKm.toFixed(6)}</td>` +
                    `<td style="padding:6px;vertical-align:middle"><button data-idx="${idx}" class="modalShowBtn" style="padding:6px 8px;margin-right:6px">Hiện</button><button data-idx="${idx}" class="modalInfoBtn" style="padding:6px 8px">Thông tin</button></td>` +
                    '</tr>';
            });
            html += '</table>';
            body.innerHTML = html;
            // attach handlers
            Array.from(body.querySelectorAll('.modalShowBtn')).forEach(btn => {
                btn.addEventListener('click', (ev) => {
                    const i = Number(ev.currentTarget.getAttribute('data-idx'));
                    // draw selected route and close modal
                    showTopResult(i);
                    document.getElementById('topResultsModal').style.display = 'none';
                });
            });
            Array.from(body.querySelectorAll('.modalInfoBtn')).forEach(btn => {
                btn.addEventListener('click', (ev) => {
                    const i = Number(ev.currentTarget.getAttribute('data-idx'));
                    alertTopResult(i);
                });
            });
            // show modal
            modal.style.display = 'block';
            // attach close
            const closeBtn = document.getElementById('closeTopResultsModal');
            if (closeBtn) closeBtn.onclick = () => { modal.style.display = 'none'; };
        }

        function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

        function getRouteNamesForPath(path) {
            if (!path || !path.length) return [];
            const names = new Set();
            for (let i = 0; i < path.length - 1; i++) {
                const a = path[i], b = path[i + 1];
                for (const [rid, segs] of segsByRoute.entries()) {
                    (segs || []).forEach(s => {
                        if (s.startdeviceid == a && s.enddeviceid == b) {
                            names.add((s.routecableid || s.name || rid).toString());
                        }
                    });
                }
            }
            return Array.from(names);
        }

        function alertTopResult(idx) {
            const results = window.__lastTopResults || [];
            const r = results[idx];
            if (!r) return alert('No result');
            const pathIds = (r.networkRes && r.networkRes.path) ? r.networkRes.path : [];

            // Build ID -> name map
            const nodeIdToName = new Map();
            nodes.forEach(n => {
                if (n && n.id != null) {
                    nodeIdToName.set(n.id, n.name || n.code || n.id);
                }
            });

            // Map IDs to names
            const pathNames = pathIds.map(id => nodeIdToName.get(id) || id);

            const msg = `#${idx + 1}\nStart: ${r.startNode && (r.startNode.name || r.startNode.id)}\nEnd: ${r.endNode && (r.endNode.name || r.endNode.id)}\nKm: ${r.networkKm.toFixed(6)}\nPath: ${pathNames.join(' -> ')}`;
            alert(msg);
        }

        async function showTopResult(idx) {
            const results = window.__lastTopResults || [];
            const r = results[idx];
            if (!r) return;
            try { walkingRoutesLayer.clearLayers(); } catch (e) { walkingRoutesLayer = L.layerGroup().addTo(map); }
            const edgeMap = window.__lastEdgeMap || buildEdgeGeometryMap();
            const adjacency = window.__lastAdjacency || buildAdjacencyForSelectedRoutes();
            const resBest = drawWeightedNetworkPathBetweenNodes(r.startNode.id, r.endNode.id, adjacency, edgeMap, { color: '#28a745', weight: 8, opacity: 0.95 });
            if (resBest && resBest.grp) walkingRoutesLayer.addLayer(resBest.grp);
            // Attempt to draw walking/pole legs for this specific candidate using current start/end picks
            try {
                let leg1 = null, leg2 = null;
                if (startPointCoords && r && r.startNode) {
                    try { leg1 = await routeViaPolesToNode(startPointCoords[0], startPointCoords[1], r.startNode.id); } catch (e) { console.warn('showTopResult: routeViaPolesToNode leg1 failed', e); }
                    if (!leg1) {
                        try { leg1 = await routeViaPolesWalk(startPointCoords[0], startPointCoords[1], r.startNode.lat, r.startNode.lng, { computeOnly: false }); } catch (e) { console.warn('showTopResult: routeViaPolesWalk leg1 failed', e); }
                    }
                    if (!leg1) {
                        try { leg1 = await chooseBestWalkingLeg(startPointCoords[0], startPointCoords[1], r.startNode.lat, r.startNode.lng, { color: '#1e90ff' }); } catch (e) { console.warn('showTopResult: chooseBestWalkingLeg leg1 failed', e); }
                    }
                }
                if (endPointCoords && r && r.endNode) {
                    try { leg2 = await routeViaPolesToNode(endPointCoords[0], endPointCoords[1], r.endNode.id); } catch (e) { console.warn('showTopResult: routeViaPolesToNode leg2 failed', e); }
                    if (!leg2) {
                        try { leg2 = await routeViaPolesWalk(endPointCoords[0], endPointCoords[1], r.endNode.lat, r.endNode.lng, { computeOnly: false }); } catch (e) { console.warn('showTopResult: routeViaPolesWalk leg2 failed', e); }
                    }
                    if (!leg2) {
                        try { leg2 = await chooseBestWalkingLeg(endPointCoords[0], endPointCoords[1], r.endNode.lat, r.endNode.lng, { color: '#1e90ff', clipToEnd: true }); } catch (e) { console.warn('showTopResult: chooseBestWalkingLeg leg2 failed', e); }
                    }
                }
                // Show popup summary
                const walkingKm1 = (leg1 && Number.isFinite(leg1.km)) ? leg1.km : 0;
                const walkingKm2 = (leg2 && Number.isFinite(leg2.km)) ? leg2.km : 0;
                const totalKm = walkingKm1 + (r.networkKm || 0) + walkingKm2;
                if (endPointMarker) endPointMarker.bindPopup(`<b>Route (candidate ${idx + 1})</b><br>Walking leg 1: ${walkingKm1.toFixed(3)} km<br>Network: ${(r.networkKm || 0).toFixed(3)} km<br>Walking leg 2: ${walkingKm2.toFixed(3)} km<br><b>Total: ${totalKm.toFixed(3)} km</b>`).openPopup();
            } catch (e) {
                console.warn('showTopResult: walking leg draw failed', e);
            }
            // fit bounds to path coords
            const bounds = [];
            const path = (r.networkRes && r.networkRes.path) || [];
            for (let i = 0; i < path.length - 1; i++) {
                const coords = (edgeMap.get(`${path[i]}-${path[i + 1]}`) || []);
                coords.forEach(c => bounds.push(c));
            }
            // clear previous route labels then add labels (white background, black text) for each node on path
            try { routeLabelsLayer.clearLayers(); } catch (e) { /* ignore */ }
            try {
                // collect and log POP / cabinet nodes along this path
                const popCabNodes = [];
                path.forEach(pid => {
                    const nodeObj = nodes.find(n => n.id === pid);
                    if (!nodeObj) return;
                    const nc = getNodeCoordinatesSimple(nodeObj);
                    if (!nc) return;
                    const name = nodeObj.name || nodeObj.code || nodeObj.id;
                    const lbl = L.marker(nc, {
                        interactive: false,
                        icon: L.divIcon({
                            html: `<div style="background:white;color:black;padding:2px 6px;border-radius:3px;border:1px solid rgba(0,0,0,0.06);font-size:11px;white-space:nowrap;">${escapeHtml(name)}</div>`,
                            className: '',
                            iconSize: null
                        })
                    });
                    routeLabelsLayer.addLayer(lbl);
                    const cls = classifyNodeType(nodeObj.type);
                    if (cls === 'pop' || cls === 'cabinet') {
                        popCabNodes.push({ id: nodeObj.id, name: name, type: cls, latlng: nc });
                    }
                });
                if (popCabNodes.length) {
                    console.log(`🟢 POP/Cabinet nodes on candidate #${idx + 1} path:`, popCabNodes);
                } else {
                    console.log(`⚪ No POP/Cabinet nodes found on candidate #${idx + 1} path`);
                }
            } catch (e) { }
            if (bounds.length) try { map.fitBounds(bounds); } catch (e) { }
        }

        // Add to near the top, after map/init:
        function clearCotLinesLayer() {
            try { cotLinesLayer.clearLayers(); } catch (e) { }
        }
        async function loadAndDrawLinesFromUrl(url) {
            try {
                clearCotLinesLayer();
                const resp = await fetch(url);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const j = await resp.json();

                const lineBounds = [];
                let drawn = 0;

                // Kiểm tra xem có phải GeoJSON FeatureCollection không
                if (j.type === 'FeatureCollection' && Array.isArray(j.features)) {
                    console.log(`📊 Processing ${j.features.length} features from GeoJSON FeatureCollection`);

                    // Xử lý GeoJSON FeatureCollection
                    j.features.forEach((feature, index) => {
                        if (!feature || feature.type !== 'Feature') return;

                        const geom = feature.geometry;
                        const props = feature.properties || {};
                        const name = props.name || props.title || props.id || '';

                        if (!geom || !geom.type || !geom.coordinates) return;

                        // Xử lý LineString
                        if (geom.type === 'LineString') {
                            const coords = geom.coordinates; // GeoJSON format: [[lng, lat], [lng, lat], ...]
                            if (!Array.isArray(coords) || coords.length === 0) return;

                            // Convert từ GeoJSON [lng, lat] sang Leaflet [lat, lng]
                            const latlngs = coords.map(coord => {
                                if (!Array.isArray(coord) || coord.length < 2) return null;
                                const lng = Number(coord[0]);
                                const lat = Number(coord[1]);
                                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                                return [lat, lng];
                            }).filter(Boolean);

                            if (latlngs.length === 0) return;

                            // Vẽ polyline
                            const pl = L.polyline(latlngs, {
                                color: '#8e24aa',
                                weight: 3,
                                opacity: 0.95
                            });

                            if (name) {
                                pl.bindTooltip(`Đường dây: ${name}`, { sticky: true });
                                pl.bindPopup(`<b>Đường dây</b><br>${name}`);
                            }

                            cotLinesLayer.addLayer(pl);
                            lineBounds.push(...latlngs);
                            drawn++;

                            // Log every 100th line to avoid console spam
                            if (drawn % 100 === 0 || drawn <= 5) {
                                console.log(`✏️ Drew line #${drawn}: ${name || 'unnamed'} (${latlngs.length} points)`);
                            }
                        }
                        // Xử lý MultiLineString
                        else if (geom.type === 'MultiLineString') {
                            if (!Array.isArray(geom.coordinates)) return;

                            geom.coordinates.forEach(lineCoords => {
                                if (!Array.isArray(lineCoords) || lineCoords.length === 0) return;

                                const latlngs = lineCoords.map(coord => {
                                    if (!Array.isArray(coord) || coord.length < 2) return null;
                                    const lng = Number(coord[0]);
                                    const lat = Number(coord[1]);
                                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                                    return [lat, lng];
                                }).filter(Boolean);

                                if (latlngs.length === 0) return;

                                const pl = L.polyline(latlngs, {
                                    color: '#8e24aa',
                                    weight: 3,
                                    opacity: 0.95
                                });

                                if (name) {
                                    pl.bindTooltip(`Đường dây: ${name}`, { sticky: true });
                                    pl.bindPopup(`<b>Đường dây</b><br>${name}`);
                                }

                                cotLinesLayer.addLayer(pl);
                                lineBounds.push(...latlngs);
                                drawn++;
                            });
                        }
                        // Xử lý Point
                        else if (geom.type === 'Point') {
                            if (!Array.isArray(geom.coordinates) || geom.coordinates.length < 2) return;

                            const lng = Number(geom.coordinates[0]);
                            const lat = Number(geom.coordinates[1]);
                            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

                            const mk = L.circleMarker([lat, lng], {
                                radius: 4,
                                color: '#ffffff',
                                weight: 2,
                                fillColor: '#8e24aa',
                                fillOpacity: 0.95
                            });

                            if (name) {
                                mk.bindTooltip(`Điểm: ${name}`);
                                mk.bindPopup(`<b>Điểm</b><br>${name}`);
                            }

                            cotLinesLayer.addLayer(mk);
                            lineBounds.push([lat, lng]);
                            drawn++;
                        }
                    });
                }
                // Fallback: xử lý dữ liệu dạng phẳng (flat array)
                else {
                    let arr = j.table || j.items || j.data || j || [];
                    if (Array.isArray(arr)) {
                        arr.forEach(s => {
                            const coords = parseLatLngString(s.latlng);
                            if (!coords || coords.length === 0) return;

                            if (coords.length === 1) {
                                const mk = L.circleMarker(coords[0], {
                                    radius: 4,
                                    color: '#ffffff',
                                    weight: 2,
                                    fillColor: '#8e24aa',
                                    fillOpacity: 0.95
                                });
                                if (s.name) mk.bindTooltip(`Đường dây: ${s.name}`);
                                cotLinesLayer.addLayer(mk);
                                lineBounds.push(coords[0]);
                            } else {
                                const pl = L.polyline(coords, {
                                    color: '#8e24aa',
                                    weight: 3,
                                    opacity: 0.95
                                });
                                if (s.name) {
                                    pl.bindTooltip(`Đường dây: ${s.name}`, { sticky: true });
                                    pl.bindPopup(`<b>Đường dây</b><br>${s.name}`);
                                }
                                cotLinesLayer.addLayer(pl);
                                lineBounds.push(...coords);
                            }
                            drawn++;
                        });
                    }
                }

                if (lineBounds.length) fitMapToLatLngs(lineBounds);

                console.log(`✅ Successfully drew ${drawn} power lines from ${url.split('/').pop()}`);

                if (drawn === 0) {
                    alert('Không tìm thấy dữ liệu đường dây hợp lệ trong file này.');
                } else {
                    alert(`Vẽ xong ${drawn} đường dây`);
                }

            } catch (e) {
                alert('Lỗi đọc file hoặc vẽ đường dây: ' + (e && e.message));
                console.warn('loadAndDrawLinesFromUrl failed', url, e);
            }
        }

        // ========== Universal Point Search ==========
        let searchResultMarkers = L.layerGroup().addTo(map);

        function searchAllPoints(query) {
            if (!query || query.trim().length < 2) {
                document.getElementById('pointSearchResults').style.display = 'none';
                searchResultMarkers.clearLayers();
                return;
            }

            const searchTerm = query.trim().toLowerCase();
            const results = [];

            // Search in nodes (from all loaded routes)
            for (const [routeId, nodeList] of nodesByRoute.entries()) {
                (nodeList || []).forEach(node => {
                    if (!node) return;

                    const name = (node.name || node.code || node.id || '').toString().toLowerCase();
                    if (name.includes(searchTerm)) {
                        const coords = getNodeCoordinatesSimple(node);
                        if (coords) {
                            const nodeType = classifyNodeType(node.type);
                            let typeLabel = 'Node';
                            if (nodeType === 'pop') typeLabel = 'POP';
                            else if (nodeType === 'cabinet') typeLabel = 'Tủ';
                            else if (nodeType === 'splice') typeLabel = 'Măng xông';

                            results.push({
                                type: 'node',
                                typeLabel: typeLabel,
                                name: node.name || node.code || node.id,
                                coords: coords,
                                routeId: routeId,
                                data: node
                            });
                        }
                    }
                });
            }

            // Search in poles
            if (poles && poles.length > 0) {
                poles.forEach(pole => {
                    if (!pole) return;

                    const name = (pole.name || pole.code || pole.id || '').toString().toLowerCase();
                    if (name.includes(searchTerm)) {
                        results.push({
                            type: 'pole',
                            typeLabel: 'Cột điện',
                            name: pole.name || pole.code || pole.id,
                            coords: [pole.lat, pole.lng],
                            data: pole
                        });
                    }
                });
            }

            // Display results
            displaySearchResults(results, searchTerm);
        }

        function displaySearchResults(results, searchTerm) {
            const resultsDiv = document.getElementById('pointSearchResults');

            if (results.length === 0) {
                resultsDiv.innerHTML = '<div style="padding: 6px; color: #999;">Không tìm thấy kết quả</div>';
                resultsDiv.style.display = 'block';
                searchResultMarkers.clearLayers();
                return;
            }

            // Limit to top 50 results
            const displayResults = results.slice(0, 50);

            let html = `<div style="padding: 4px; font-weight: bold; border-bottom: 1px solid #ddd; margin-bottom: 4px;">
                Tìm thấy ${results.length} kết quả${results.length > 50 ? ' (hiển thị 50)' : ''}
            </div>`;

            displayResults.forEach((result, idx) => {
                html += `<div style="padding: 4px; margin: 2px 0; background: white; border-radius: 2px; cursor: pointer; border-left: 3px solid ${result.type === 'node' ? '#1e90ff' : '#ff8c00'};"
                    onclick="zoomToPoint(${result.coords[0]}, ${result.coords[1]}, '${result.name.replace(/'/g, "\\'")}', '${result.typeLabel}', ${idx})"
                    onmouseover="this.style.background='#e3f2fd'"
                    onmouseout="this.style.background='white'">
                    <div style="font-weight: bold; color: #333;">${result.typeLabel}: ${result.name}</div>
                    <div style="font-size: 10px; color: #666;">
                        ${result.routeId ? `Route: ${result.routeId} | ` : ''}
                        Tọa độ: ${result.coords[0].toFixed(6)}, ${result.coords[1].toFixed(6)}
                    </div>
                </div>`;
            });

            resultsDiv.innerHTML = html;
            resultsDiv.style.display = 'block';

            // Add markers for all results
            searchResultMarkers.clearLayers();
            displayResults.forEach((result, idx) => {
                const marker = L.circleMarker(result.coords, {
                    radius: 6,
                    color: result.type === 'node' ? '#1e90ff' : '#ff8c00',
                    weight: 2,
                    fillColor: result.type === 'node' ? '#87ceeb' : '#ffd1a3',
                    fillOpacity: 0.8
                });
                marker.bindTooltip(`${result.typeLabel}: ${result.name}`);
                marker.bindPopup(`<b>${result.typeLabel}</b><br>${result.name}<br>
                    ${result.routeId ? `Route: ${result.routeId}<br>` : ''}
                    Tọa độ: ${result.coords[0].toFixed(6)}, ${result.coords[1].toFixed(6)}`);
                searchResultMarkers.addLayer(marker);
            });
        }

        function zoomToPoint(lat, lng, name, typeLabel, idx) {
            map.setView([lat, lng], 18);

            // Highlight the selected marker
            searchResultMarkers.eachLayer((layer, i) => {
                if (layer.getLatLng) {
                    const latlng = layer.getLatLng();
                    if (Math.abs(latlng.lat - lat) < 0.000001 && Math.abs(latlng.lng - lng) < 0.000001) {
                        layer.openPopup();
                        // Temporarily enlarge the marker
                        layer.setStyle({ radius: 10, weight: 3 });
                        setTimeout(() => {
                            layer.setStyle({ radius: 6, weight: 2 });
                        }, 1500);
                    }
                }
            });
        }

        // Event listeners for search
        const pointSearchInput = document.getElementById('pointSearchInput');
        const clearPointSearchBtn = document.getElementById('clearPointSearch');

        if (pointSearchInput) {
            // Debounce search input
            let searchTimeout;
            pointSearchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    searchAllPoints(e.target.value);
                }, 300);
            });

            pointSearchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    clearTimeout(searchTimeout);
                    searchAllPoints(e.target.value);
                }
            });
        }

        if (clearPointSearchBtn) {
            clearPointSearchBtn.addEventListener('click', () => {
                pointSearchInput.value = '';
                document.getElementById('pointSearchResults').style.display = 'none';
                searchResultMarkers.clearLayers();
            });
        }
