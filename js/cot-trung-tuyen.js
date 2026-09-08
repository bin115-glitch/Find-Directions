// ========== Cột Trung Thế (Medium Voltage Poles) Functions ==========

const COT_TRUNG_MANIFEST_FALLBACK = [];
let COT_TRUNG_INDEX_DATA = null;
let COT_TRUNG_MANIFEST_CACHE = [];
let GROUPING_MANIFEST = null;

async function loadCotTrungManifest() {
    const cont = document.getElementById('cottrungtuyenCheckboxes');
    if (!cont) return;
    cont.innerHTML = 'Đang tải danh sách cột trung thế...';
    const manifestPath = '/api/cot-trung-tuyen/regions';
    const indexPath = './cot_trung_tuyen/json_cot/index2.json';
    try {
        console.log('Loading cot manifest from API:', manifestPath);
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
        const baseDir = manifestPath.substring(0, manifestPath.lastIndexOf('/'));
        const resolved = items.map(it => {
            const copy = Object.assign({}, it);
            if (copy.url && !copy.url.match(/^[a-zA-Z]+:\/\//) && !copy.url.startsWith('/')) {
                let u = copy.url.replace(/^\.\//, '');
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
    if (COT_TRUNG_MANIFEST_FALLBACK.length) {
        buildCotTrungUI(COT_TRUNG_MANIFEST_FALLBACK);
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
        return s.toLowerCase()
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'd')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    };
    const detectCotFileType = (str) => {
        const nm = normalizeFileName(str);
        if (!nm) return 'unknown';
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

    // Build UI elements
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
            const fileName = (normalizedUrl || displayName).split('/').pop().split('\\').pop();
            const fileType = detectCotFileType(fileName);
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
            } catch (e) { }
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

        if (optType === 'tba') {
            await loadCotTrungSet(key || opt.value, url, 'tba');
        } else if (optType === 'line') {
            await loadAndDrawLines(url);
        } else {
            await loadCotTrungSet(key || opt.value, url, 'cot');
        }
    });
}

async function loadFilesForRegion(key, urlBase) {
    const filesSel = document.getElementById('cottrungFilesSelect');
    if (!filesSel) return false;
    filesSel.innerHTML = '';
    let appended = false;

    if (urlBase.toLowerCase().endsWith('.json')) {
        const fname = urlBase.split('/').pop();
        const opt = document.createElement('option');
        opt.text = (function (u) { try { return decodeURIComponent(u); } catch (e) { return u; } })(fname);
        opt.value = urlBase;
        opt.dataset.url = urlBase;
        opt.dataset.fileType = detectCotFileType(urlBase);
        opt.dataset.key = key + '__' + fname;
        filesSel.appendChild(opt);
        appended = true;
        return appended;
    }

    const opt = document.createElement('option');
    opt.text = '-- Không tìm thấy file (Hãy cập nhật index2.json) --';
    opt.disabled = true;
    filesSel.appendChild(opt);
    return appended;
}

function detectCotFileType(str) {
    const normalizeFileName = (s) => {
        if (!s) return '';
        try {
            s = s.split('/').pop().split('\\').pop();
        } catch (e) { }
        return s.toLowerCase()
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'd')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    };
    const nm = normalizeFileName(str);
    if (!nm) return 'unknown';
    const hasLine = (nm.includes('duong') && nm.includes('day')) ||
        (nm.includes('đường') && nm.includes('dây')) ||
        nm.includes('duong_day') ||
        nm.includes('duongday') ||
        nm.includes('duong-day');
    if (hasLine) return 'line';
    if (nm.includes('tba')) return 'tba';
    return 'cot';
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
        try { cotTrungLayer.clearLayers(); } catch (e) { }
        const bounds = [];
        parsed.forEach(p => {
            if (!p || p.lat == null || p.lng == null) return;
            bounds.push([p.lat, p.lng]);
            const style = COT_STYLE[iconType] || COT_STYLE.cot;

            let mk;
            if (iconType === 'cot') {
                const icon = L.icon({
                    iconUrl: './icon/cot.png',
                    iconSize: [16, 16],
                    iconAnchor: [8, 8],
                    popupAnchor: [0, -8]
                });
                mk = L.marker([p.lat, p.lng], { icon: icon, title: p.name || p.code || p.id });
            } else {
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
        rebuildPolesFromSelection();
        fitMapToLatLngs(bounds);
        console.log('Loaded cot trung the set', key, parsed.length);
    } catch (e) {
        console.warn('loadCotTrungSet failed', url, e);
    }
}

async function loadAndDrawLines(url) {
    return await loadAndDrawLinesFromUrl(url);
}

async function loadAndDrawLinesFromUrl(url) {
    try {
        cotLinesLayer.clearLayers();
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const j = await resp.json();
        let arr = j.table || j.items || j.data || j || [];
        if (!Array.isArray(arr)) {
            if (Array.isArray(j.features)) {
                arr = j.features;
            } else {
                arr = [];
            }
        }
        const bounds = [];
        arr.forEach(item => {
            let coords = [];
            if (item.geometry && item.geometry.type === 'LineString' && Array.isArray(item.geometry.coordinates)) {
                coords = item.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
            } else if (item.latlng) {
                coords = parseLatLngString(item.latlng);
            }
            if (coords.length < 2) return;
            const line = L.polyline(coords, { color: '#00ff00', weight: 3, opacity: 0.9 });
            const name = (item.properties && item.properties.name) || item.name || 'Đường dây';
            line.bindTooltip(name);
            line.bindPopup(`<b>Đường dây</b><br>${name}`);
            cotLinesLayer.addLayer(line);
            coords.forEach(c => bounds.push(c));
        });
        if (bounds.length) fitMapToLatLngs(bounds);
        console.log('Loaded lines from', url, arr.length);
    } catch (e) {
        console.warn('loadAndDrawLinesFromUrl failed', url, e);
    }
}
