        // initialize map
        const map = L.map('map').setView([21.03, 105.81], 12);

        // elements
        const statusEl = document.getElementById('status');
        const routeCheckboxes = document.getElementById('routeCheckboxes');
        const poleCheckboxes = document.getElementById('poleCheckboxes');

        const baseTileUrls = [
            'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'
        ];
        let baseTileIndex = 0;
        let baseTileLayer = null;
        let baseTileErrorCount = 0;

        function showBaseTileError(message) {
            if (statusEl) statusEl.innerHTML = `<span class="text-warning">${message}</span>`;
        }

        function activateBaseTile(index) {
            if (baseTileLayer) map.removeLayer(baseTileLayer);
            baseTileIndex = index;
            baseTileErrorCount = 0;
            baseTileLayer = L.tileLayer(baseTileUrls[index], {
                maxZoom: 19,
                crossOrigin: true,
                attribution: '&copy; OpenStreetMap contributors'
            });
            baseTileLayer.on('tileerror', () => {
                baseTileErrorCount += 1;
                if (baseTileErrorCount >= 3 && baseTileIndex < baseTileUrls.length - 1) {
                    activateBaseTile(baseTileIndex + 1);
                    return;
                }
                if (baseTileErrorCount >= 3) {
                    showBaseTileError('Khong tai duoc nen ban do. Kiem tra ket noi/proxy Internet.');
                }
            });
            baseTileLayer.addTo(map);
        }

        activateBaseTile(0);

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
        // Pole records remain available for routing and are shown as lightweight dots.
        const polesLayer = L.layerGroup().addTo(map);
        const poleLinksLayer = L.layerGroup().addTo(map);
        const POLE_DOT_STYLE = Object.freeze({
            radius: 2.5,
            color: '#ff8c00',
            weight: 1,
            fillColor: '#ff8c00',
            fillOpacity: 0.9,
            interactive: false
        });
        let poleCodeIndex = new Map(); // normCode -> Array<pole>
        let nodeCodeIndex = new Map(); // normCode -> Array<node>
        // layer for nearby search results
        const nearbyStartLayer = L.layerGroup().addTo(map);
        const nearbyEndLayer = L.layerGroup().addTo(map);
        // layer for drawn network paths
        let walkingRoutesLayer = L.layerGroup().addTo(map);
        // layer for lines (đường dây)
        const cotLinesLayer = L.layerGroup().addTo(map);
        // Separate layer for transformer points; they are displayed but do not
        // participate in the pole-to-pole routing graph.
        const cotTrungTbaLayer = L.layerGroup().addTo(map);
        let cotTrungActivePoles = [];
        let cotTrungLineGeometries = [];
        let cotTrungLineAdjacencyDirty = true;
        let cotTrungActivePoleSet = new Set();

        function isMediumPoleRecord(pole) {
            return cotTrungActivePoleSet.has(pole);
        }

        function isMediumPoleIndex(index) {
            return isMediumPoleRecord(poles[index]);
        }
        // candidate containers
        let startNearbyCandidates = [];
        let endNearbyCandidates = [];
        // map alternate/missing node IDs to canonical node IDs
        let nodeIdMap = new Map();
        let routeRunDebugLines = [];
        let nodeByScopedId = new Map();

        function normalizeNodeLocalId(id) {
            if (id == null) return null;
            const num = Number(id);
            if (!Number.isNaN(num)) return num;
            return String(id);
        }

        function makeScopedNodeId(routeId, localId) {
            const normalized = normalizeNodeLocalId(localId);
            if (normalized == null) return null;
            return `${routeId}:${normalized}`;
        }

        function findNodeById(id) {
            if (id == null) return null;
            return nodeByScopedId.get(id) || nodes.find(n => n.id === id) || null;
        }

        function formatDebugValue(value) {
            if (typeof value === 'string') return value;
            try {
                return JSON.stringify(value, null, 2);
            } catch (e) {
                return String(value);
            }
        }

        function resetRouteRunDebug(context = {}) {
            routeRunDebugLines = [];
            appendRouteRunDebug('route-run-start', { timestamp: new Date().toISOString(), ...context });
        }

        function appendRouteRunDebug(label, value) {
            routeRunDebugLines.push(`## ${label}\n${formatDebugValue(value)}`);
        }

        async function flushRouteRunDebug(status = 'done') {
            try {
                const payload = {
                    timestamp: new Date().toISOString(),
                    content: [`STATUS: ${status}`, ...routeRunDebugLines].join('\n\n')
                };
                const resp = await fetch('/api/save-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!resp.ok) {
                    const text = await resp.text().catch(() => '');
                    throw new Error(`save-log failed: ${resp.status} ${text}`.trim());
                }
                statusEl.textContent = `Log saved ${new Date().toLocaleTimeString()}`;
            } catch (e) {
                console.warn('flushRouteRunDebug failed', e);
                statusEl.textContent = `Log save failed: ${e && e.message ? e.message : e}`;
            }
        }

        function setRouteLoading(isLoading, title = 'Dang tim duong', message = 'He thong dang tinh tuyen toi uu theo cot dien va ring.') {
            const overlay = document.getElementById('routeLoadingOverlay');
            const titleEl = document.getElementById('routeLoadingTitle');
            const msgEl = document.getElementById('routeLoadingMessage');
            if (titleEl) titleEl.textContent = title;
            if (msgEl) msgEl.textContent = message;
            if (overlay) overlay.classList.toggle('active', !!isLoading);
        }

        function showRouteAlert(type, message) {
            const host = document.getElementById('routeAlertHost');
            if (!host) return;
            const color = type === 'success' ? 'success' : (type === 'warning' ? 'warning' : (type === 'danger' ? 'danger' : 'info'));
            if (host.__routeAlertTimer) window.clearTimeout(host.__routeAlertTimer);
            host.innerHTML = `<div class="alert alert-${color} alert-dismissible fade show small mb-0" role="alert">
                ${message}
                <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
            </div>`;
            host.__routeAlertTimer = window.setTimeout(() => {
                const alertEl = host.querySelector('.alert');
                if (!alertEl) return;
                // Remove the current alert directly; this avoids a stale Bootstrap
                // Alert instance trying to remove an element that was replaced.
                if (alertEl.parentNode === host) alertEl.remove();
            }, 4500);
        }

        function enhanceBootstrapUI() {
            const btnMap = [
                ['collapseBtn', 'btn btn-sm btn-outline-secondary'],
                ['getCoordinatesBtn', 'btn btn-success btn-sm'],
                ['clearClickMarker', 'btn btn-danger btn-sm'],
                ['openRouteSelector', 'btn btn-outline-primary btn-sm'],
                ['openPoleSelector', 'btn btn-outline-primary btn-sm'],
                ['openCotTrungSelector', 'btn btn-outline-primary btn-sm'],
                ['selectAllRoutes', 'btn btn-outline-primary btn-sm'],
                ['clearAllRoutes', 'btn btn-outline-secondary btn-sm'],
                ['selectAllPolesets', 'btn btn-outline-primary btn-sm'],
                ['clearAllPolesets', 'btn btn-outline-secondary btn-sm'],
                ['clearPointSearch', 'btn btn-outline-secondary btn-sm'],
                ['showCandidatesBtn', 'btn btn-primary'],
                ['closeTopResultsModal', 'btn btn-outline-secondary btn-sm'],
                ['sidebarHandle', 'btn btn-light btn-sm']
            ];
            btnMap.forEach(([id, cls]) => {
                const el = document.getElementById(id);
                if (el) el.className = cls;
            });

            const pointSearchInput = document.getElementById('pointSearchInput');
            if (pointSearchInput) pointSearchInput.className = 'form-control form-control-sm';

            const sidebarHeader = document.querySelector('#sidebar > div');
            if (sidebarHeader) sidebarHeader.className = 'd-flex align-items-center justify-content-between';

            const status = document.getElementById('status');
            if (status) status.classList.add('small');

            const groups = Array.from(document.querySelectorAll('#sidebar > div')).slice(2, 7);
            groups.forEach(group => group.classList.add('mt-3'));

            const searchRow = pointSearchInput && pointSearchInput.parentElement;
            if (searchRow) searchRow.className = 'd-flex gap-2 align-items-center';
            updateSelectionSummaries();
        }

        function setSelectorPopupVisible(popupId, isVisible) {
            document.querySelectorAll('.selector-popup').forEach(popup => popup.classList.remove('active'));
            if (!isVisible) return;
            const popup = document.getElementById(popupId);
            if (popup) popup.classList.add('active');
        }

        function updateSelectionSummaries() {
            const routeSummary = document.getElementById('routeSelectionSummary');
            const poleSummary = document.getElementById('poleSelectionSummary');
            const cotSummary = document.getElementById('cotTrungSelectionSummary');

            if (routeSummary) {
                const selectedRoutes = Array.from(routeCheckboxes.querySelectorAll('input:checked'));
                routeSummary.textContent = selectedRoutes.length
                    ? `Da chon ${selectedRoutes.length} tuyen`
                    : 'Chua chon tuyen nao';
            }

            if (poleSummary) {
                const selectedPoles = Array.from(poleCheckboxes.querySelectorAll('input:checked'));
                poleSummary.textContent = selectedPoles.length
                    ? `Da chon ${selectedPoles.length} bo cot`
                    : 'Chua chon bo cot nao';
            }

            if (cotSummary) {
                const selectedTexts = (id) => Array.from(document.getElementById(id)?.selectedOptions || [])
                    .filter(opt => opt.value && !opt.disabled)
                    .map(opt => opt.text.trim());
                const regions = selectedTexts('cottrungRegionSelect');
                const districts = selectedTexts('XaRegionSelect');
                const files = selectedTexts('cottrungFilesSelect');
                const parts = [];
                if (regions.length) parts.push(`${regions.length} tỉnh`);
                if (districts.length) parts.push(`${districts.length} xã/huyện`);
                if (files.length) parts.push(`${files.length} file`);
                cotSummary.textContent = parts.length ? parts.join(' / ') : 'Chưa chọn tỉnh, xã/huyện hoặc file';
            }
        }

        function setupSelectorPopups() {
            const routeWrapper = routeCheckboxes && routeCheckboxes.parentElement;
            const poleWrapper = poleCheckboxes && poleCheckboxes.parentElement;
            const cotWrapper = document.getElementById('cottrungtuyenCheckboxes') && document.getElementById('cottrungtuyenCheckboxes').parentElement;

            const routeBody = document.getElementById('routeSelectorBody');
            const poleBody = document.getElementById('poleSelectorBody');
            const cotBody = document.getElementById('cotTrungSelectorBody');

            if (routeWrapper && routeBody && routeWrapper.parentElement !== routeBody) routeBody.appendChild(routeWrapper);
            if (poleWrapper && poleBody && poleWrapper.parentElement !== poleBody) poleBody.appendChild(poleWrapper);
            if (cotWrapper && cotBody && cotWrapper.parentElement !== cotBody) cotBody.appendChild(cotWrapper);

            const openMap = [
                ['openRouteSelector', 'routeSelectorPopup'],
                ['openPoleSelector', 'poleSelectorPopup'],
                ['openCotTrungSelector', 'cotTrungSelectorPopup']
            ];
            openMap.forEach(([buttonId, popupId]) => {
                const btn = document.getElementById(buttonId);
                if (!btn || btn.dataset.bound === '1') return;
                btn.dataset.bound = '1';
                btn.addEventListener('click', () => {
                    const popup = document.getElementById(popupId);
                    const shouldOpen = !(popup && popup.classList.contains('active'));
                    setSelectorPopupVisible(popupId, shouldOpen);
                });
            });

            document.querySelectorAll('.selector-close').forEach(btn => {
                if (btn.dataset.bound === '1') return;
                btn.dataset.bound = '1';
                btn.addEventListener('click', () => setSelectorPopupVisible(btn.dataset.popup, false));
            });

            if (!document.body.dataset.selectorPopupBound) {
                document.body.dataset.selectorPopupBound = '1';
                document.addEventListener('click', (event) => {
                    const insidePopup = event.target.closest('.selector-popup');
                    const launcher = event.target.closest('#openRouteSelector, #openPoleSelector, #openCotTrungSelector');
                    if (!insidePopup && !launcher) setSelectorPopupVisible(null, false);
                });
            }

            routeCheckboxes.addEventListener('change', updateSelectionSummaries);
            poleCheckboxes.addEventListener('change', updateSelectionSummaries);
            updateSelectionSummaries();
        }

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
        async function loadCotTrungManifest() {
            const cont = document.getElementById('cottrungtuyenCheckboxes');
            if (!cont) return;
            cont.innerHTML = 'Đang tải danh sách cột trung thế...';
            // The data folder is inside find_directions, next to index.html.
            // Using ../ points outside the Flask static root and leaves the
            // medium-voltage graph empty without making the route fail loudly.
            const manifestPath = './cot_trung_tuyen/json_cot/manifest.json';
            const indexPath = './cot_trung_tuyen/json_cot/index2.json';
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
                buildCotTrungUI(resolved);
                return;
            } catch (err) {
                console.warn('No manifest; using fallback or scanning directories', err);
            }
            // fallback
            if (COT_TRUNG_MANIFEST_FALLBACK.length) {
                buildCotTrungUI(COT_TRUNG_MANIFEST_FALLBACK);
            } else {
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
            const selectPreferredCotFile = (preferences = ['line', 'cot', 'tba'], dispatchOptions = {}) => {
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
                    if (dispatchOptions.load !== false) {
                        filesSel.dispatchEvent(new Event('change'));
                    }
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
            regionLabel.textContent = 'Chọn tỉnh (có thể chọn nhiều):';
            regionLabel.style.display = 'block';
            regionLabel.style.marginBottom = '6px';
            cont.appendChild(regionLabel);

            const regionSel = document.createElement('select');
            regionSel.id = 'cottrungRegionSelect';
            regionSel.multiple = true;
            regionSel.size = Math.max(items.length, 10);
            regionSel.style.width = '100%';
            regionSel.style.marginBottom = '8px';
            const emptyOpt = document.createElement('option'); emptyOpt.value = ''; emptyOpt.text = '-- Chọn tỉnh --'; emptyOpt.disabled = true;
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
            cotxa.multiple = true;
            cotxa.size = 14;
            cotxa.style.width = '100%';
            cotxa.style.marginBottom = '8px';
            cotxa.style.display = '';
            cotxa.disabled = true;
            const emptyOptXa = document.createElement('option');
            emptyOptXa.value = '';
            emptyOptXa.text = '-- Chọn xã/huyện --';
            emptyOptXa.disabled = true;
            cotxa.appendChild(emptyOptXa);
            cont.appendChild(cotxa);

            const filesLabel = document.createElement('label');
            filesLabel.textContent = 'Cột trung thế sẽ tự động được nạp (có thể chọn nhiều xã):';
            filesLabel.style.display = 'block';
            filesLabel.style.margin = '6px 0 4px 0';
            cont.appendChild(filesLabel);
            const filesSel = document.createElement('select');
            filesSel.id = 'cottrungFilesSelect';
            filesSel.multiple = true;
            filesSel.size = 12;
            filesSel.style.width = '100%';
            [regionSel, cotxa, filesSel].forEach(select => {
                // Toggle one option per click so multi-selection behaves like checkboxes.
                select.addEventListener('mousedown', event => {
                    const option = event.target;
                    if (!option || option.tagName !== 'OPTION' || option.disabled) return;
                    event.preventDefault();
                    option.selected = !option.selected;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                });
            });
            cont.appendChild(filesSel);

            const populateFilesFromIndex = (regionKey, districtName, options = {}) => {
                if (!options.append) filesSel.innerHTML = '';
                if (!regionKey || !districtName || !indexRegions || !indexRegions[regionKey]) return false;
                const list = indexRegions[regionKey][districtName];
                if (!Array.isArray(list) || !list.length) return false;
                let added = false;
                const existingUrls = new Set(Array.from(filesSel.options).map(option => option.dataset.url).filter(Boolean));
                list.forEach(fileInfo => {
                    const opt = document.createElement('option');
                    const displayName = decodeText(fileInfo.name || fileInfo.url || 'file');
                    const normalizedUrl = normalizeCotUrl(fileInfo.url || '');

                    // Extract filename from URL for better type detection
                    const fileName = (normalizedUrl || displayName).split('/').pop().split('\\').pop();
                    const fileType = detectCotFileType(fileName);

                    // This mode routes through medium-voltage poles only.
                    if (fileType !== 'cot') return;

                    if (normalizedUrl && existingUrls.has(normalizedUrl)) return;

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
                    opt.dataset.regionKey = regionKey;
                    opt.dataset.districtName = districtName;
                    filesSel.appendChild(opt);
                    if (normalizedUrl) existingUrls.add(normalizedUrl);
                    added = true;
                });
                return added;
            };

            const populateDistrictOptions = async (regionKeys, regionOpts) => {
                cotxa.innerHTML = '';
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.text = '-- Chọn xã/huyện --';
                placeholder.disabled = true;
                cotxa.appendChild(placeholder);
                cotxa.disabled = true;
                cotxa.style.display = '';

                const districtMap = new Map();
                const upsert = (regionKey, regionOpt, label, updater) => {
                    if (!label) return;
                    const norm = `${regionKey}|${normalizeDistrictKey(label)}`;
                    if (!norm) return;
                    if (!districtMap.has(norm)) {
                        districtMap.set(norm, { regionKey, regionOpt, displayName: label });
                    }
                    const entry = districtMap.get(norm);
                    if (!entry.displayName) entry.displayName = label;
                    updater(entry);
                };

                const keys = Array.isArray(regionKeys) ? regionKeys : (regionKeys ? [regionKeys] : []);
                const opts = Array.isArray(regionOpts) ? regionOpts : (regionOpts ? [regionOpts] : []);
                for (let i = 0; i < keys.length; i++) {
                    const regionKey = keys[i];
                    const regionOpt = opts[i] || opts.find(opt => opt.value === regionKey);
                    if (indexRegions && indexRegions[regionKey]) {
                        Object.keys(indexRegions[regionKey]).forEach(name => {
                            upsert(regionKey, regionOpt, name, entry => {
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
                                    upsert(regionKey, regionOpt, name, entry => {
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
                            upsert(regionKey, regionOpt, dirName, entry => {
                                entry.dirName = dirName;
                                entry.dirUrl = dirUrl;
                                entry.hasDirectory = true;
                                if (!entry.displayName) entry.displayName = dirName;
                            });
                        });
                    }
                }

                const entries = Array.from(districtMap.values()).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'vi', { sensitivity: 'base' }));
                entries.forEach(entry => {
                    const opt = document.createElement('option');
                    opt.value = entry.displayName || entry.indexName || entry.dirName || '';
                    opt.text = entry.displayName || opt.value;
                    opt.dataset.regionKey = entry.regionKey || '';
                    opt.dataset.regionUrl = entry.regionOpt?.dataset?.url || '';
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

            let districtChangeSerial = 0;
            let autoLoadTimer = null;
            const scheduleAutoLoadAllFiles = () => {
                clearTimeout(autoLoadTimer);
                autoLoadTimer = setTimeout(() => {
                    // For route finding, load only the medium-voltage pole file.
                    // Wire and TBA files remain available for optional manual display.
                    const validFiles = Array.from(filesSel.options)
                        .filter(opt => !opt.disabled && opt.dataset && opt.dataset.url)
                        .filter(opt => (opt.dataset.fileType || detectCotFileType(opt.dataset.url || opt.text)) === 'cot');
                    if (!validFiles.length) return;
                    Array.from(filesSel.options).forEach(opt => { opt.selected = false; });
                    validFiles.forEach(opt => { opt.selected = true; });
                    filesSel.dispatchEvent(new Event('change', { bubbles: true }));
                }, 350);
            };

            regionSel.addEventListener('change', async (ev) => {
                const sel = ev.currentTarget;
                const selectedRegions = Array.from(sel.selectedOptions).filter(opt => opt.value);
                const regionKeys = selectedRegions.map(opt => opt.value);
                filesSel.innerHTML = '';
                const hasDistricts = await populateDistrictOptions(regionKeys, selectedRegions);
                if (hasDistricts) { updateSelectionSummaries(); return; }
                if (!selectedRegions.length) {
                    updateSelectionSummaries();
                    const o = document.createElement('option'); o.text = '-- Không có --'; filesSel.appendChild(o); return;
                }
                for (const opt of selectedRegions) {
                    const url = opt.dataset && opt.dataset.url;
                    if (url) await loadFilesForRegion(opt.value, url, { append: true });
                }
                updateSelectionSummaries();
            });

            cotxa.addEventListener('change', async (ev) => {
                const sel = ev.currentTarget;
                const changeSerial = ++districtChangeSerial;
                const chosenDistricts = Array.from(sel.selectedOptions).filter(opt => opt.value);
                filesSel.innerHTML = '';
                for (const chosen of chosenDistricts) {
                    if (changeSerial !== districtChangeSerial) return;
                    const xa = chosen.value;
                    const regionKey = chosen.dataset.regionKey;
                    const regionOpt = Array.from(regionSel.selectedOptions).find(opt => opt.value === regionKey);
                    const indexName = chosen.dataset.indexName;
                    const dirUrl = chosen.dataset.dirUrl;
                    let populated = false;
                    if (indexName) populated = populateFilesFromIndex(regionKey, indexName, { append: true });
                    if (!populated) populated = populateFilesFromIndex(regionKey, xa, { append: true });
                    if (!populated && dirUrl) populated = await loadFilesForRegion(regionKey + '__' + xa, dirUrl, { append: true });
                    if (changeSerial !== districtChangeSerial) return;
                    if (!populated) {
                        const baseUrl = regionOpt && regionOpt.dataset && regionOpt.dataset.url;
                        if (baseUrl) {
                            const directoryUrl = (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) + '/' + encodeURIComponent(xa);
                            await loadFilesForRegion(regionKey + '__' + xa, directoryUrl, { append: true });
                        }
                    }
                }
                // Select a sensible default without loading a large dataset yet.
                if (filesSel.options.length) selectPreferredCotFile(['line', 'cot', 'tba'], { load: false });
                // Selecting a district automatically displays all of its datasets.
                if (filesSel.options.length) scheduleAutoLoadAllFiles();
                updateSelectionSummaries();
            });

            filesSel.addEventListener('change', async (ev) => {
                const selected = Array.from(ev.currentTarget.selectedOptions)
                    .filter(opt => !opt.disabled && opt.dataset && opt.dataset.url);
                if (!selected.length) return;

                const loadingToken = (window.__cotTrungLoadingCount || 0) + 1;
                window.__cotTrungLoadingCount = loadingToken;
                const routeButton = document.getElementById('showCandidatesBtn');
                if (routeButton) {
                    routeButton.disabled = true;
                    routeButton.title = 'Đang tải dữ liệu cột trung thế...';
                }

                // Reset the medium-voltage layer once, then merge every selected file.
                cotTrungActivePoles = [];
                cotTrungActivePoleSet = new Set();
                cotTrungLineGeometries = [];
                cotTrungLineAdjacencyDirty = true;
                try { clearCotLinesLayer(); } catch (e) { }
                try { cotTrungTbaLayer.clearLayers(); } catch (e) { }
                rebuildPolesFromSelection();

                const getType = (opt) => opt.dataset.fileType || detectCotFileType(opt.dataset.url || opt.text);
                const allFileOptions = Array.from(filesSel.options)
                    .filter(opt => !opt.disabled && opt.dataset && opt.dataset.url);
                const fileGroup = (opt) => opt.dataset.districtName
                    ? `${opt.dataset.regionKey || ''}__${opt.dataset.districtName}`
                    : (opt.dataset.key || opt.value).replace(/__(?:[^_]+)$/u, '');
                const findPaired = (opt, wantedType) => {
                    const group = fileGroup(opt);
                    const sameGroup = allFileOptions.filter(candidate => fileGroup(candidate) === group);
                    return sameGroup.find(candidate => getType(candidate) === wantedType)
                        || allFileOptions.find(candidate => getType(candidate) === wantedType);
                };

                const loadedLines = new Set();
                const loadedPoles = new Set();
                for (const opt of selected) {
                    const url = opt.dataset.url;
                    const type = getType(opt);
                    const key = opt.dataset.key || opt.value;
                    if (type === 'line' && !loadedLines.has(url)) {
                        loadedLines.add(url);
                        await loadAndDrawLines(url, { append: true, quiet: true });
                        const poleOpt = findPaired(opt, 'cot');
                        if (poleOpt && !loadedPoles.has(poleOpt.dataset.url)) {
                            loadedPoles.add(poleOpt.dataset.url);
                            await loadCotTrungSet(poleOpt.dataset.key || poleOpt.value, poleOpt.dataset.url, 'cot');
                        }
                    } else if (type === 'cot' && !loadedPoles.has(url)) {
                        loadedPoles.add(url);
                        await loadCotTrungSet(key, url, 'cot');
                        const lineOpt = findPaired(opt, 'line');
                        if (lineOpt && !loadedLines.has(lineOpt.dataset.url)) {
                            loadedLines.add(lineOpt.dataset.url);
                            await loadAndDrawLines(lineOpt.dataset.url, { append: true, quiet: true });
                        }
                    } else if (type === 'tba') {
                        await loadCotTrungSet(key, url, 'tba');
                    }
                }
                try { rebuildCotTrungLineAdjacency(); } catch (e) { console.warn('rebuildCotTrungLineAdjacency failed', e); }
                try { drawAllPoleLinks(); } catch (e) { console.warn('drawAllPoleLinks failed', e); }
                if (window.__cotTrungLoadingCount === loadingToken) {
                    window.__cotTrungLoadingCount = 0;
                    if (routeButton) {
                        routeButton.disabled = false;
                        routeButton.title = '';
                    }
                }
                updateSelectionSummaries();
            });
        }

        // Attempt to load a list of files for a region. We expect either:
        // - region manifest at url + '/manifest.json' returning array of {key,name,url}
        // - or url is a directory; try fetch url + '/index.json' or list single file if url ends with .json
        async function loadFilesForRegion(key, urlBase, options = {}) {
            const filesSel = document.getElementById('cottrungFilesSelect');
            if (!filesSel) return false;
            if (!options.append) filesSel.innerHTML = '';
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
                            if (detectCotFileType(web) !== 'cot') return;
                            const opt = document.createElement('option');
                            opt.text = fname;
                            opt.value = web;
                            opt.dataset.url = web;
                            opt.dataset.fileType = detectCotFileType(web);
                            opt.dataset.key = key + '__' + fname;
                            opt.dataset.regionKey = regionCode;
                            opt.dataset.districtName = districtName;
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
                if (detectCotFileType(urlBase) !== 'cot') return false;
                const opt = document.createElement('option');
                opt.text = (function (u) { try { return decodeURIComponent(u); } catch (e) { return u; } })(fname);
                opt.value = urlBase;
                opt.dataset.url = urlBase;
                opt.dataset.fileType = detectCotFileType(urlBase);
                opt.dataset.key = key + '__' + fname;
                if (key.includes('__')) {
                    const parts = key.split('__');
                    opt.dataset.regionKey = parts[0];
                    opt.dataset.districtName = parts.slice(1).join('__');
                }
                filesSel.appendChild(opt);
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
                if (iconType === 'cot') {
                    const existing = new Set(cotTrungActivePoles.map(p => `${p.code || p.id || p.name || ''}|${p.lat}|${p.lng}`));
                    const additions = parsed.filter(p => {
                        const poleKey = `${p.code || p.id || p.name || ''}|${p.lat}|${p.lng}`;
                        if (existing.has(poleKey)) return false;
                        existing.add(poleKey);
                        return true;
                    });
                    cotTrungActivePoles = cotTrungActivePoles.concat(additions);
                    additions.forEach(pole => cotTrungActivePoleSet.add(pole));
                    cotTrungLineAdjacencyDirty = true;
                }
                // render parsed poles immediately in a dedicated layer (cot trung the)
                const bounds = [];
                parsed.forEach(p => {
                    if (p && p.lat != null && p.lng != null) bounds.push([p.lat, p.lng]);
                });
                if (iconType === 'tba') {
                    parsed.forEach(p => {
                        if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
                        const marker = L.circleMarker([p.lat, p.lng], {
                            radius: 5,
                            color: '#c62828',
                            weight: 1,
                            fillColor: '#ef5350',
                            fillOpacity: 0.9
                        });
                        const name = p.name || p.code || p.id || 'TBA';
                        marker.bindTooltip(`TBA: ${name}`, { sticky: true });
                        marker.bindPopup(`<b>Trạm biến áp</b><br>${name}<br>Tọa độ: ${p.lat}, ${p.lng}`);
                        cotTrungTbaLayer.addLayer(marker);
                    });
                }
                // also update pole UI/checklists so user can toggle other pole sets
                if (typeof buildPoleUI === 'function') {
                    buildPoleUI();
                } else {
                    console.warn('buildPoleUI is not defined; skipping pole UI rebuild');
                }
                rebuildPolesFromSelection();
                try { rebuildCotTrungLineAdjacency(); } catch (e) { console.warn('rebuildCotTrungLineAdjacency failed', e); }
                if (iconType !== 'tba') fitMapToLatLngs(bounds);
                console.log('Loaded cot trung the set', key, {
                    iconType,
                    records: parsed.length,
                    unifiedPoleCount: poles.length,
                    lineCount: cotTrungLineGeometries.length
                });
                return parsed.length;
            } catch (e) {
                console.warn('loadCotTrungSet failed', url, e);
                return null;
            }
        }

        // Load a JSON of lines (Đường_Dây) and draw green polylines on cotLinesLayer
        async function loadAndDrawLines(url, options = {}) {
            return await loadAndDrawLinesFromUrl(url, options);
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

        function calculatePolylineDistanceKm(coords) {
            let totalKm = 0;
            for (let i = 1; i < (coords || []).length; i++) {
                totalKm += calculateDistance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
            }
            return totalKm;
        }

        function drawCableGeometry(geometry, fromCoords, toCoords, layer, style, options = {}) {
            if (!Array.isArray(geometry) || geometry.length < 2) return 0;
            const targetLayer = layer || walkingRoutesLayer;
            const maxConnectorKm = Number.isFinite(options.maxConnectorKm) ? options.maxConnectorKm : 0.06;
            const maxFromConnectorKm = Number.isFinite(options.maxFromConnectorKm) ? options.maxFromConnectorKm : maxConnectorKm;
            const maxToConnectorKm = Number.isFinite(options.maxToConnectorKm) ? options.maxToConnectorKm : maxConnectorKm;
            const shouldDraw = options.draw !== false;
            let totalKm = 0;
            const addConnector = (left, right, allowedKm) => {
                if (!left || !right) return;
                const gapKm = calculateDistance(left[0], left[1], right[0], right[1]);
                if (gapKm <= 0.000001 || gapKm > allowedKm) return;
                if (shouldDraw) targetLayer.addLayer(L.polyline([left, right], style));
                totalKm += gapKm;
            };

            addConnector(fromCoords, geometry[0], maxFromConnectorKm);
            if (shouldDraw) targetLayer.addLayer(L.polyline(geometry, style));
            totalKm += calculatePolylineDistanceKm(geometry);
            addConnector(geometry[geometry.length - 1], toCoords, maxToConnectorKm);
            return totalKm;
        }

        function drawPointToPoleCable(pointCoords, pole, layer, options = {}) {
            if (!Array.isArray(pointCoords) || !pole) return 0;
            const poleCoords = [pole.lat, pole.lng];
            const km = calculateDistance(pointCoords[0], pointCoords[1], poleCoords[0], poleCoords[1]);
            if (km <= 0.000001) return 0;
            if (options.draw !== false) {
                (layer || walkingRoutesLayer).addLayer(L.polyline([pointCoords, poleCoords], {
                    color: options.color || '#1e90ff',
                    weight: options.weight || 6,
                    opacity: typeof options.opacity === 'number' ? options.opacity : 0.9,
                    dashArray: options.dashArray || null
                }));
            }
            return km;
        }

        function findNearestMediumLineAttachment(pointCoords, maxSnapKm) {
            if (!Array.isArray(pointCoords) || !Number.isFinite(maxSnapKm) || maxSnapKm <= 0) return null;
            if (!(window.__mediumLineAttachmentCache instanceof Map)) window.__mediumLineAttachmentCache = new Map();
            const cacheKey = `${Number(pointCoords[0]).toFixed(6)},${Number(pointCoords[1]).toFixed(6)}|${maxSnapKm.toFixed(6)}`;
            if (window.__mediumLineAttachmentCache.has(cacheKey)) return window.__mediumLineAttachmentCache.get(cacheKey);
            const linePoleAttachments = window.cotTrungLinePoleAttachments instanceof Map
                ? window.cotTrungLinePoleAttachments
                : new Map();
            let best = null;
            (cotTrungLineGeometries || []).forEach((line, lineIndex) => {
                const coords = Array.isArray(line) ? line : line && line.coords;
                if (!Array.isArray(coords) || coords.length < 2) return;
                const metrics = buildPolylineMetrics(coords);
                const projection = projectPointToPolyline(pointCoords, coords, metrics);
                if (!projection || projection.distKm > maxSnapKm) return;
                const poleCandidates = linePoleAttachments.get(lineIndex) || [];
                poleCandidates.forEach(candidate => {
                    if (!candidate || !Number.isInteger(candidate.index)) return;
                    const alongKm = Math.abs(candidate.kmAlong - projection.kmAlong);
                    const totalKm = projection.distKm + alongKm + candidate.distance;
                    if (!best || totalKm < best.totalKm) {
                        best = {
                            lineIndex,
                            geometry: coords,
                            projection: projection.point,
                            projectionKmAlong: projection.kmAlong,
                            poleIndex: candidate.index,
                            pole: poles[candidate.index],
                            poleKmAlong: candidate.kmAlong,
                            pointToLineKm: projection.distKm,
                            lineToPoleKm: alongKm + candidate.distance,
                            totalKm
                        };
                    }
                });
            });
            window.__mediumLineAttachmentCache.set(cacheKey, best);
            return best;
        }

        function drawPointToPoleOrWireCable(pointCoords, pole, layer, options = {}) {
            if (!Array.isArray(pointCoords) || !pole) return { km: 0, usedExistingLine: false };
            const poleCoords = [pole.lat, pole.lng];
            const pointSnapKm = Number.isFinite(options.pointSnapKm)
                ? options.pointSnapKm
                : (getEndpointSearchRadiusKm(false) || 0.06);
            const poleSnapKm = Number.isFinite(options.poleSnapKm) ? options.poleSnapKm : 0.06;
            const lineGeometry = findMediumLineGeometryBetweenPoints(
                pointCoords,
                poleCoords,
                pointSnapKm,
                { fromMaxSnapKm: pointSnapKm, toMaxSnapKm: poleSnapKm }
            );
            if (lineGeometry) {
                const draw = options.draw !== false;
                const km = drawCableGeometry(
                    lineGeometry.geometry,
                    pointCoords,
                    poleCoords,
                    layer || walkingRoutesLayer,
                    {
                        color: options.color || '#1e90ff',
                        weight: options.weight || 4,
                        opacity: typeof options.opacity === 'number' ? options.opacity : 0.95,
                        dashArray: options.dashArray || '6,6'
                    },
                    {
                        draw,
                        maxFromConnectorKm: pointSnapKm,
                        maxToConnectorKm: poleSnapKm
                    }
                );
                if (typeof appendRouteRunDebug === 'function') appendRouteRunDebug('endpoint-wire-attachment', {
                    pole: pole.name || pole.code || pole.id,
                    lineIndex: lineGeometry.lineIndex,
                    pointToLineKm: lineGeometry.fromDistanceKm,
                    poleToLineKm: lineGeometry.toDistanceKm,
                    geometryKm: calculatePolylineDistanceKm(lineGeometry.geometry),
                    pointSnapKm,
                    poleSnapKm
                });
                return { km, usedExistingLine: true, lineIndex: lineGeometry.lineIndex };
            }
            // If the selected pole is not projected onto the same LineString,
            // still attach the requested point to the nearest real wire. This
            // avoids drawing one long flight line caused by small data offsets.
            const nearestWire = findNearestMediumLineAttachment(pointCoords, pointSnapKm);
            if (nearestWire) {
                const wirePoint = nearestWire.projection;
                const pointToWireKm = calculateDistance(pointCoords[0], pointCoords[1], wirePoint[0], wirePoint[1]);
                const wireToPoleGeometry = slicePolylineBetween(
                    nearestWire.geometry,
                    nearestWire.projectionKmAlong,
                    nearestWire.poleKmAlong
                );
                if (options.draw !== false && pointToWireKm > 0.000001) {
                    (layer || walkingRoutesLayer).addLayer(L.polyline([pointCoords, wirePoint], {
                        color: options.color || '#1e90ff',
                        weight: options.weight || 4,
                        opacity: typeof options.opacity === 'number' ? options.opacity : 0.95,
                        dashArray: options.dashArray || '6,6'
                    }));
                }
                let wireToPoleKm = 0;
                if (Array.isArray(wireToPoleGeometry) && wireToPoleGeometry.length >= 2 && nearestWire.pole) {
                    wireToPoleKm = drawCableGeometry(
                        wireToPoleGeometry,
                        wirePoint,
                        [nearestWire.pole.lat, nearestWire.pole.lng],
                        layer || walkingRoutesLayer,
                        {
                            color: options.color || '#1e90ff',
                            weight: options.weight || 4,
                            opacity: typeof options.opacity === 'number' ? options.opacity : 0.95,
                            dashArray: options.dashArray || '6,6'
                        },
                        { draw: options.draw !== false, maxFromConnectorKm: 0.001, maxToConnectorKm: poleSnapKm }
                    );
                }
                if (typeof appendRouteRunDebug === 'function') appendRouteRunDebug('endpoint-nearest-wire-attachment', {
                    selectedPole: pole.name || pole.code || pole.id,
                    attachedPole: nearestWire.pole && (nearestWire.pole.name || nearestWire.pole.code || nearestWire.pole.id),
                    lineIndex: nearestWire.lineIndex,
                    pointToLineKm: nearestWire.pointToLineKm,
                    lineToPoleKm: nearestWire.lineToPoleKm,
                    pointSnapKm
                });
                return { km: pointToWireKm + wireToPoleKm, usedExistingLine: true, lineIndex: nearestWire.lineIndex, attachment: nearestWire };
            }
            const km = drawPointToPoleCable(pointCoords, pole, layer, {
                draw: options.draw !== false,
                color: options.color,
                weight: options.weight || 6,
                opacity: typeof options.opacity === 'number' ? options.opacity : 0.9,
                dashArray: options.dashArray || null
            });
            return { km, usedExistingLine: false };
        }

        function rebuildCotTrungLineAdjacency() {
            if (!cotTrungLineAdjacencyDirty && window.cotTrungPoleAdjacency && window.cotTrungPoleEdgeGeometry && window.cotTrungLinePoleAttachments) return;
            const adjacency = new Map();
            const edgeGeometry = new Map();
            const activePoleIndexes = new Map();
            const COT_LINE_POLE_MATCH_KM = 0.06; // 60m coordinate-error tolerance
            const COT_LINE_JUNCTION_KM = 0.02; // 20m: a pole can join different named lines only here
            (cotTrungActivePoles || []).forEach(pole => {
                const index = poles.indexOf(pole);
                if (index >= 0) activePoleIndexes.set(pole, index);
            });

            // First collect every possible projection. A pole close to two crossing
            // lines must not automatically become a junction between them.
            const poleLineCandidates = new Map();
            (cotTrungLineGeometries || []).forEach((line, lineIndex) => {
                const coords = Array.isArray(line) ? line : line.coords;
                const lineName = normalizeCode(Array.isArray(line) ? '' : (line.name || ''));
                if (!Array.isArray(coords) || coords.length < 2) return;
                const lineMetrics = buildPolylineMetrics(coords);
                for (const [pole, index] of activePoleIndexes.entries()) {
                    const projected = projectPointToPolyline([pole.lat, pole.lng], coords, lineMetrics);
                    if (!projected || projected.distKm > COT_LINE_POLE_MATCH_KM) continue;
                    const endpointDistance = Math.min(projected.kmAlong, projected.totalKm - projected.kmAlong);
                    if (!poleLineCandidates.has(index)) poleLineCandidates.set(index, []);
                    poleLineCandidates.get(index).push({
                        index,
                        lineIndex,
                        lineName,
                        kmAlong: projected.kmAlong,
                        distance: projected.distKm,
                        nearEndpoint: endpointDistance <= COT_LINE_JUNCTION_KM
                    });
                }
            });

            // Assign a pole to one physical line by default. Keep a second line
            // only for a real junction: same named line, or both projections are
            // within 20m and close to their segment endpoints. This prevents a
            // pole near parallel/crossing wires from creating a false shortcut.
            const acceptedByLine = new Map();
            for (const [poleIndex, candidates] of poleLineCandidates.entries()) {
                candidates.sort((a, b) => a.distance - b.distance);
                const best = candidates[0];
                const accepted = candidates.filter(candidate => {
                    if (candidate.lineIndex === best.lineIndex) return true;
                    const equallyClose = candidate.distance <= Math.max(COT_LINE_JUNCTION_KM, best.distance + 0.005);
                    if (candidate.lineName && candidate.lineName === best.lineName && equallyClose) return true;
                    return candidate.distance <= COT_LINE_JUNCTION_KM &&
                        best.distance <= COT_LINE_JUNCTION_KM &&
                        candidate.nearEndpoint && best.nearEndpoint;
                });
                accepted.forEach(candidate => {
                    if (!acceptedByLine.has(candidate.lineIndex)) acceptedByLine.set(candidate.lineIndex, []);
                    acceptedByLine.get(candidate.lineIndex).push(candidate);
                });
            }

            acceptedByLine.forEach((linePoles, lineIndex) => {
                const line = cotTrungLineGeometries[lineIndex];
                const coords = Array.isArray(line) ? line : line.coords;
                if (!Array.isArray(coords) || coords.length < 2) return;
                // A LineString can contain many pole positions. Connect consecutive
                // poles using the real line geometry, never a straight shortcut.
                linePoles.sort((a, b) => a.kmAlong - b.kmAlong);
                const orderedPoles = [];
                const seenPoleIndexes = new Set();
                linePoles.forEach(item => {
                    if (!seenPoleIndexes.has(item.index)) {
                        seenPoleIndexes.add(item.index);
                        orderedPoles.push(item);
                    }
                });
                if (orderedPoles.length < 2) return;

                const addOrReplace = (from, to, geometry, cost) => {
                    if (!Number.isFinite(cost) || cost <= 0) return;
                    if (!adjacency.has(from)) adjacency.set(from, []);
                    if (!adjacency.has(to)) adjacency.set(to, []);
                    const geometryKey = `${from}-${to}`;
                    const list = adjacency.get(from);
                    const existing = list.find(item => item.to === to);
                    if (!existing || cost < existing.cost) {
                        if (existing) existing.cost = cost;
                        else list.push({ to, cost, source: 'cot-trung-line' });
                        edgeGeometry.set(geometryKey, geometry);
                    }
                };
                for (let i = 0; i < orderedPoles.length - 1; i++) {
                    const left = orderedPoles[i];
                    const right = orderedPoles[i + 1];
                    if (left.index === right.index) continue;
                    const geometry = slicePolylineBetween(coords, left.kmAlong, right.kmAlong);
                    const cost = calculatePolylineDistanceKm(geometry);
                    addOrReplace(left.index, right.index, geometry, cost);
                    addOrReplace(right.index, left.index, geometry.slice().reverse(), cost);
                }
            });

            window.cotTrungPoleAdjacency = adjacency;
            window.cotTrungPoleEdgeGeometry = edgeGeometry;
            window.cotTrungLinePoleAttachments = acceptedByLine;
            window.__mediumLineAttachmentCache = new Map();
            cotTrungLineAdjacencyDirty = false;
            console.log('Built cot trung the line adjacency:', {
                poles: activePoleIndexes.size,
                edges: Array.from(adjacency.values()).reduce((sum, list) => sum + list.length, 0)
            });
        }

        function getCombinedPoleAdjacency() {
            if (!poles || poles.length === 0) return new Map();
            try { if (!window.poleAdjacency || (window.poleAdjacency && window.poleAdjacency.size === 0)) buildPoleCodeAdjacency(); } catch (err) { console.warn('buildPoleCodeAdjacency failed', err); }
            try { if (!window.poleProximityAdj || (window.poleProximityAdj && window.poleProximityAdj.size === 0)) buildPoleProximityAdj(); } catch (err) { console.warn('buildPoleProximityAdj failed', err); }
            try { rebuildCotTrungLineAdjacency(); } catch (err) { console.warn('rebuildCotTrungLineAdjacency failed', err); }

            const combinedAdj = new Map();
            for (let i = 0; i < poles.length; i++) combinedAdj.set(i, []);
            if (window.poleAdjacency && window.poleAdjacency.size) {
                for (const [k, nbrs] of window.poleAdjacency.entries()) {
                    nbrs.forEach(n => {
                        // For any edge touching a medium-voltage pole, the loaded
                        // line geometry is the source of truth. Retain only a very
                        // short bridge for a normal-pole/medium-pole junction.
                        // With line files omitted, medium-to-medium edges come
                        // from the spatial pole graph and must remain routable.
                        const mediumFrom = isMediumPoleIndex(k);
                        const mediumTo = isMediumPoleIndex(n.to);
                        const mixedPair = mediumFrom !== mediumTo;
                        const bridgeKm = mixedPair ? calculateDistance(poles[k].lat, poles[k].lng, poles[n.to].lat, poles[n.to].lng) : 0;
                        if (mixedPair && bridgeKm > 0.02) return;
                        if (!combinedAdj.get(k).some(x => x.to === n.to)) combinedAdj.get(k).push({ to: n.to, cost: n.cost, source: 'code' });
                    });
                }
            }

            if (window.poleProximityAdj && window.poleProximityAdj.size) {
                for (const [k, nbrs] of window.poleProximityAdj.entries()) {
                    nbrs.forEach(n => {
                        const mediumFrom = isMediumPoleIndex(k);
                        const mediumTo = isMediumPoleIndex(n.to);
                        const mixedPair = mediumFrom !== mediumTo;
                        const bridgeKm = mixedPair ? calculateDistance(poles[k].lat, poles[k].lng, poles[n.to].lat, poles[n.to].lng) : 0;
                        if (mixedPair && bridgeKm > 0.02) return;
                        if (!combinedAdj.get(k).some(x => x.to === n.to)) combinedAdj.get(k).push({ to: n.to, cost: n.cost, source: 'proximity' });
                    });
                }
            }

            if (window.cotTrungPoleAdjacency && window.cotTrungPoleAdjacency.size) {
                for (const [k, nbrs] of window.cotTrungPoleAdjacency.entries()) {
                    if (!combinedAdj.has(k)) combinedAdj.set(k, []);
                    nbrs.forEach(n => {
                        const existingIndex = combinedAdj.get(k).findIndex(x => x.to === n.to);
                        const edge = { to: n.to, cost: n.cost, source: 'cot-trung-line' };
                        if (existingIndex < 0) combinedAdj.get(k).push(edge);
                        else combinedAdj.get(k)[existingIndex] = edge;
                    });
                }
            }

            return combinedAdj;
        }

        function findPoleNeighbors(lat, lng, snapKm = getPoleSnapRadiusKm(), limit = 12) {
            const out = [];
            if (!poles || poles.length === 0) return out;
            for (let i = 0; i < poles.length; i++) {
                const p = poles[i];
                const d = calculateDistance(lat, lng, p.lat, p.lng);
                if (d <= snapKm) out.push({ idx: i, cost: d });
            }
            out.sort((a, b) => a.cost - b.cost);
            return out.slice(0, limit);
        }

        function getPoleNeighborGroups(lat, lng, snapKm = getPoleSnapRadiusKm(), limit = 12) {
            const regularPoles = [];
            const mediumVoltagePoles = [];
            const activeMediumVoltage = new Set(cotTrungActivePoles || []);
            for (let i = 0; i < poles.length; i++) {
                const pole = poles[i];
                const distance = calculateDistance(lat, lng, pole.lat, pole.lng);
                if (distance > snapKm) continue;
                const target = activeMediumVoltage.has(pole) ? mediumVoltagePoles : regularPoles;
                target.push({ idx: i, cost: distance });
            }
            regularPoles.sort((a, b) => a.cost - b.cost);
            mediumVoltagePoles.sort((a, b) => a.cost - b.cost);
            const allPoles = regularPoles.concat(mediumVoltagePoles).sort((a, b) => a.cost - b.cost);
            return {
                all: allPoles.slice(0, limit),
                regular: regularPoles.slice(0, limit),
                medium: mediumVoltagePoles.slice(0, limit)
            };
        }

        function computePreferredPolePathPreview(startLat, startLng, endLat, endLng, poleAdj, snapKm = getPoleSnapRadiusKm()) {
            // Regular and medium-voltage poles are one endpoint network. The
            // medium line JSON only controls the geometry of its pole-to-pole
            // edges; it must not change which pole is selected at an endpoint.
            const startNeighbors = findPoleNeighbors(startLat, startLng, snapKm, 12);
            const endNeighbors = findPoleNeighbors(endLat, endLng, snapKm, 12);
            // Prefer a pole reached through the nearest existing medium wire.
            // This is tried before point-distance candidates so the endpoint
            // cable meets the wire first, then follows the pole graph.
            const startAttachment = findNearestMediumLineAttachment([startLat, startLng], snapKm);
            const endAttachment = findNearestMediumLineAttachment([endLat, endLng], snapKm);
            let preview = null;
            if (startAttachment && endAttachment) {
                preview = computePolePathPreview(
                    [{ idx: startAttachment.poleIndex, cost: startAttachment.totalKm }],
                    [{ idx: endAttachment.poleIndex, cost: endAttachment.totalKm }],
                    poleAdj
                );
            }
            if (!preview && startAttachment) {
                preview = computePolePathPreview(
                    [{ idx: startAttachment.poleIndex, cost: startAttachment.totalKm }],
                    endNeighbors,
                    poleAdj
                );
            }
            if (!preview && endAttachment) {
                preview = computePolePathPreview(
                    startNeighbors,
                    [{ idx: endAttachment.poleIndex, cost: endAttachment.totalKm }],
                    poleAdj
                );
            }
            if (!preview) preview = computePolePathPreview(startNeighbors, endNeighbors, poleAdj);
            if (!preview) return null;
            return Object.assign(preview, {
                startType: 'all',
                endType: 'all',
                startNeighborsCount: startNeighbors.length,
                endNeighborsCount: endNeighbors.length
            });
        }

        function computePolePathPreview(startNeighbors, endNeighbors, poleAdj) {
            if (!startNeighbors.length || !endNeighbors.length || !poleAdj || !poleAdj.size) return null;
            const n = poles.length;
            const sortedStarts = startNeighbors.slice().sort((a, b) => a.cost - b.cost);
            const sortedEnds = endNeighbors.slice().sort((a, b) => a.cost - b.cost);

            // Endpoint policy: attach to the nearest pole that has a connected
            // path. Do not choose a farther pole merely because its complete
            // path happens to be shorter; that creates a cable that appears to
            // skip the nearest physical pole.
            for (const start of sortedStarts) {
                const dist = new Array(n).fill(Infinity);
                const prev = new Array(n).fill(-1);
                const visited = new Array(n).fill(false);
                const pq = [{ idx: start.idx, d: 0 }];
                dist[start.idx] = 0;

                while (pq.length) {
                    pq.sort((a, b) => a.d - b.d);
                    const current = pq.shift();
                    if (!current || visited[current.idx]) continue;
                    visited[current.idx] = true;
                    if (current.d > dist[current.idx]) continue;
                    const neighbors = poleAdj.get(current.idx) || [];
                    for (const e of neighbors) {
                        const nd = current.d + e.cost;
                        if (nd < dist[e.to]) {
                            dist[e.to] = nd;
                            prev[e.to] = current.idx;
                            pq.push({ idx: e.to, d: nd });
                        }
                    }
                }

                // At the destination, apply the same nearest-first rule.
                const end = sortedEnds.find(candidate => Number.isFinite(dist[candidate.idx]));
                if (!end) continue;

                const pathIdx = [];
                let cur = end.idx;
                while (cur !== -1) {
                    pathIdx.push(cur);
                    if (cur === start.idx) break;
                    cur = prev[cur];
                }
                if (pathIdx[pathIdx.length - 1] !== start.idx) continue;
                pathIdx.reverse();
                return {
                    km: start.cost + dist[end.idx] + end.cost,
                    pathIdx,
                    startPoleDistanceKm: start.cost,
                    endPoleDistanceKm: end.cost
                };
            }
            return null;
        }

        function decodePolyline6(encoded) {
            const coords = [];
            let index = 0;
            let lat = 0;
            let lng = 0;
            while (index < encoded.length) {
                let result = 0;
                let shift = 0;
                let byte;
                do {
                    byte = encoded.charCodeAt(index++) - 63;
                    result |= (byte & 0x1f) << shift;
                    shift += 5;
                } while (byte >= 0x20 && index < encoded.length);
                lat += (result & 1) ? ~(result >> 1) : (result >> 1);
                result = 0;
                shift = 0;
                do {
                    byte = encoded.charCodeAt(index++) - 63;
                    result |= (byte & 0x1f) << shift;
                    shift += 5;
                } while (byte >= 0x20 && index < encoded.length);
                lng += (result & 1) ? ~(result >> 1) : (result >> 1);
                coords.push([lat / 1e6, lng / 1e6]);
            }
            return coords;
        }

        async function drawRoadRoute(startLat, startLng, endLat, endLng, options = {}) {
            const cache = window.__roadRouteCache instanceof Map
                ? window.__roadRouteCache
                : (window.__roadRouteCache = new Map());
            const cacheKey = `${startLat.toFixed(6)},${startLng.toFixed(6)}|${endLat.toFixed(6)},${endLng.toFixed(6)}`;
            let route = cache.get(cacheKey);

            if (!route) {
                const requests = [
                    async () => {
                        const response = await fetch('https://valhalla1.openstreetmap.de/route', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                locations: [
                                    { lat: startLat, lon: startLng },
                                    { lat: endLat, lon: endLng }
                                ],
                                costing: 'auto',
                                units: 'kilometers',
                                shape_format: 'geojson',
                                directions_options: { units: 'kilometers' }
                            })
                        });
                        if (!response.ok) throw new Error(`Valhalla HTTP ${response.status}`);
                        const data = await response.json();
                        const leg = data.trip && data.trip.legs && data.trip.legs[0];
                        if (!leg) throw new Error('Valhalla không có tuyến');
                        let coords = [];
                        if (leg.shape && Array.isArray(leg.shape.coordinates)) {
                            coords = leg.shape.coordinates.map(([lng, lat]) => [lat, lng]);
                        } else if (typeof leg.shape === 'string') {
                            coords = decodePolyline6(leg.shape);
                        }
                        if (coords.length < 2) throw new Error('Valhalla không có hình tuyến');
                        return {
                            coords,
                            km: Number(leg.summary && leg.summary.length) || calculatePolylineDistanceKm(coords),
                            provider: 'Valhalla'
                        };
                    },
                    async () => {
                        const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
                        const response = await fetch(url);
                        if (!response.ok) throw new Error(`OSRM HTTP ${response.status}`);
                        const data = await response.json();
                        const best = data.routes && data.routes[0];
                        if (!best || !best.geometry || !Array.isArray(best.geometry.coordinates)) throw new Error('OSRM không có tuyến');
                        const coords = best.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
                        return { coords, km: Number(best.distance) / 1000, provider: 'OSRM' };
                    }
                ];
                for (const request of requests) {
                    try {
                        route = await request();
                        break;
                    } catch (error) {
                        console.warn('Road routing provider failed:', error && error.message);
                    }
                }
                if (route) cache.set(cacheKey, route);
            }

            if (!route || !Array.isArray(route.coords) || route.coords.length < 2) return null;
            if (options.draw !== false) {
                const line = L.polyline(route.coords, {
                    color: options.color || '#1e90ff',
                    weight: options.weight || 6,
                    opacity: typeof options.opacity === 'number' ? options.opacity : 0.9,
                    dashArray: options.dashArray || '2,6'
                });
                (options.layer || walkingRoutesLayer).addLayer(line);
                return { line, km: route.km, drawn: true, road: true, provider: route.provider };
            }
            return { km: route.km, drawn: false, road: true, provider: route.provider };
        }

        // Dijkstra on pole graph; then use the road route only for endpoint access
        async function routeViaPolesWalk(startLat, startLng, endLat, endLng, options = {}) {
            if (!poles || poles.length === 0) return null;
            const poleAdj = getCombinedPoleAdjacency();
            const snapKm = getPoleSnapRadiusKm();
            const preview = computePreferredPolePathPreview(startLat, startLng, endLat, endLng, poleAdj, snapKm);
            const startGroups = getPoleNeighborGroups(startLat, startLng, snapKm, 12);
            const endGroups = getPoleNeighborGroups(endLat, endLng, snapKm, 12);
            const debugInfo = {
                startAllCount: startGroups.all.length,
                endAllCount: endGroups.all.length,
                startRegularCount: startGroups.regular.length,
                startMediumCount: startGroups.medium.length,
                endRegularCount: endGroups.regular.length,
                endMediumCount: endGroups.medium.length,
                selectedStartType: preview && preview.startType,
                selectedEndType: preview && preview.endType,
                selectedStartPole: preview && poles[preview.pathIdx[0]] ? {
                    name: poles[preview.pathIdx[0]].name || poles[preview.pathIdx[0]].code || poles[preview.pathIdx[0]].id,
                    lat: poles[preview.pathIdx[0]].lat,
                    lng: poles[preview.pathIdx[0]].lng,
                    distanceKm: preview.startPoleDistanceKm
                } : null,
                selectedEndPole: preview && poles[preview.pathIdx[preview.pathIdx.length - 1]] ? {
                    name: poles[preview.pathIdx[preview.pathIdx.length - 1]].name || poles[preview.pathIdx[preview.pathIdx.length - 1]].code || poles[preview.pathIdx[preview.pathIdx.length - 1]].id,
                    lat: poles[preview.pathIdx[preview.pathIdx.length - 1]].lat,
                    lng: poles[preview.pathIdx[preview.pathIdx.length - 1]].lng,
                    distanceKm: preview.endPoleDistanceKm
                } : null,
                snapKm
            };
            console.log('Debug: routeViaPolesWalk neighbors', debugInfo);
            if (typeof appendRouteRunDebug === 'function') appendRouteRunDebug('pole-route-preview', debugInfo);
            if (!preview) return null;
            const pathIdx = preview.pathIdx;
            const latlngs = [];
            latlngs.push([startLat, startLng]);
            for (const i of pathIdx) latlngs.push([poles[i].lat, poles[i].lng]);
            latlngs.push([endLat, endLng]);
            let totalKm = 0;
            // draw legs: for pole->pole pairs, if code-based edge exists draw via routing; otherwise draw straight lines
            for (let i = 0; i < latlngs.length - 1; i++) {
                const a = latlngs[i];
                const b = latlngs[i + 1];
                if (i === 0) {
                    const endpointCable = drawPointToPoleOrWireCable(
                        a,
                        poles[pathIdx[0]],
                        options.layer || walkingRoutesLayer,
                        { draw: !options.computeOnly, pointSnapKm: snapKm, poleSnapKm: 0.06 }
                    );
                    totalKm += endpointCable.km;
                } else if (i === latlngs.length - 2) {
                    const endpointCable = drawPointToPoleOrWireCable(
                        b,
                        poles[pathIdx[pathIdx.length - 1]],
                        options.layer || walkingRoutesLayer,
                        { draw: !options.computeOnly, pointSnapKm: snapKm, poleSnapKm: 0.06 }
                    );
                    totalKm += endpointCable.km;
                } else {
                    const fromIndex = pathIdx[i - 1];
                    const toIndex = pathIdx[i];
                    const geometry = (window.cotTrungPoleEdgeGeometry && window.cotTrungPoleEdgeGeometry.get(`${fromIndex}-${toIndex}`)) || [a, b];
                    totalKm += drawCableGeometry(geometry, a, b, options.layer || walkingRoutesLayer, {
                        color: '#1e90ff', weight: 4, opacity: 0.95, dashArray: '6,6'
                    }, { draw: !options.computeOnly, maxConnectorKm: 0.06 });
                }
            }
            return { km: totalKm, drawn: !options.computeOnly };
        }

        async function previewPoleRouteToNode(startLat, startLng, endNodeId) {
            if (!poles || poles.length === 0) return null;
            if (!endNodeId) return null;
            const endNode = findNodeById(endNodeId);
            if (!endNode || !endNode.latlng) return null;
            const endCoords = getNodeCoordinatesSimple(endNode);
            if (!endCoords) return null;
            const poleAdj = getCombinedPoleAdjacency();
            const preview = computePreferredPolePathPreview(startLat, startLng, endCoords[0], endCoords[1], poleAdj, getPoleSnapRadiusKm());
            if (!preview) return null;
            return { km: preview.km, pathIdx: preview.pathIdx, endCoords };
        }

        // route via poles to a specific network node (draw straight pole-to-pole connectors)
        async function routeViaPolesToNode(startLat, startLng, endNodeId, options = {}) {
            const preview = await previewPoleRouteToNode(startLat, startLng, endNodeId);
            if (!preview) return null;
            const firstPole = poles[preview.pathIdx[0]];
            const lastPole = poles[preview.pathIdx[preview.pathIdx.length - 1]];
            const poleSelectionDebug = {
                endNodeId,
                pathPoleCount: preview.pathIdx.length,
                startPole: firstPole ? { name: firstPole.name || firstPole.code || firstPole.id, lat: firstPole.lat, lng: firstPole.lng, distanceKm: preview.startPoleDistanceKm } : null,
                endPole: lastPole ? { name: lastPole.name || lastPole.code || lastPole.id, lat: lastPole.lat, lng: lastPole.lng, distanceKm: preview.endPoleDistanceKm } : null
            };
            console.log('Selected endpoint poles', poleSelectionDebug);
            if (typeof appendRouteRunDebug === 'function') appendRouteRunDebug('selected-endpoint-poles', poleSelectionDebug);
            if (options.computeOnly) return { km: preview.km, drawn: false };

            const pathIdx = preview.pathIdx;
            const endCoords = preview.endCoords;
            let totalKm = 0;
            // Always draw the new cable from the requested point to the nearest
            // selected pole before following the existing pole/wire network.
            totalKm += drawPointToPoleOrWireCable([startLat, startLng], firstPole, walkingRoutesLayer).km;
            for (let i = 0; i < pathIdx.length - 1; i++) {
                const a = poles[pathIdx[i]];
                const b = poles[pathIdx[i + 1]];
                const straight = [[a.lat, a.lng], [b.lat, b.lng]];
                const geometry = (window.cotTrungPoleEdgeGeometry && window.cotTrungPoleEdgeGeometry.get(`${pathIdx[i]}-${pathIdx[i + 1]}`)) || straight;
                totalKm += drawCableGeometry(geometry, [a.lat, a.lng], [b.lat, b.lng], walkingRoutesLayer, {
                    color: '#1e90ff', weight: 4, opacity: 0.95, dashArray: '6,6'
                }, { maxConnectorKm: 0.06 });
            }
            if (calculateDistance(lastPole.lat, lastPole.lng, endCoords[0], endCoords[1]) > 0.000001) {
                const lineGeometry = findMediumLineGeometryBetweenPoints(
                    [lastPole.lat, lastPole.lng],
                    endCoords
                );
                if (lineGeometry) {
                    // The node is on/near an existing medium-voltage wire:
                    // follow that wire instead of drawing a new diagonal cable.
                    totalKm += drawCableGeometry(lineGeometry.geometry, [lastPole.lat, lastPole.lng], endCoords, walkingRoutesLayer, {
                        color: '#1e90ff',
                        weight: 4,
                        opacity: 0.95,
                        dashArray: '6,6'
                    }, { maxConnectorKm: 0.06 });
                    if (typeof appendRouteRunDebug === 'function') appendRouteRunDebug('node-attachment-on-medium-line', {
                        endNodeId,
                        lineIndex: lineGeometry.lineIndex,
                        poleToLineKm: lineGeometry.fromDistanceKm,
                        nodeToLineKm: lineGeometry.toDistanceKm,
                        geometryKm: calculatePolylineDistanceKm(lineGeometry.geometry)
                    });
                } else {
                    // The node is not near a medium-voltage wire, so this is a
                    // genuine new cable segment to the selected network node.
                    totalKm += drawCableGeometry([[lastPole.lat, lastPole.lng], endCoords], [lastPole.lat, lastPole.lng], endCoords, walkingRoutesLayer, {
                        color: '#1e90ff', weight: 6, opacity: 0.9
                    }, { maxConnectorKm: 0.06 });
                }
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

            // A nearby pole means this leg must use the pole network. Do not silently
            // replace it with a misleading direct line when the pole graph is broken.
            const nearbyStartPoles = findPoleNeighbors(startLat, startLng, getPoleSnapRadiusKm(), 1);
            if (nearbyStartPoles.length) {
                console.warn('chooseBestWalkingLeg: nearby pole exists but no connected pole route', {
                    startLat, startLng, endLat, endLng,
                    nearestPoleDistanceKm: nearbyStartPoles[0].cost
                });
                return null;
            }

            // No pole exists at the endpoint. Follow the road network to the
            // selected ring point before using a straight line as last resort.
            try {
                const road = await drawRoadRoute(startLat, startLng, endLat, endLng, {
                    color: opts.color || '#1e90ff',
                    weight: opts.weight || 6,
                    opacity: (typeof opts.opacity === 'number') ? opts.opacity : 0.9,
                    layer: targetLayer
                });
                if (road) return road;
            } catch (e) {
                console.warn('chooseBestWalkingLeg: road route failed', e);
            }

            if (typeof appendRouteRunDebug === 'function') appendRouteRunDebug('road-route-unavailable', {
                start: [startLat, startLng],
                end: [endLat, endLng]
            });
            return null;
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

            // Keep the old pole-to-pole visual links, but use the actual medium-
            // voltage LineString geometry so the displayed link follows the wire.
            try { rebuildCotTrungLineAdjacency(); } catch (e) { }
            const mediumIndexes = new Set((cotTrungActivePoles || []).map(p => poles.indexOf(p)).filter(i => i >= 0));
            const drawnWirePairs = new Set();
            if (window.cotTrungPoleAdjacency && window.cotTrungPoleEdgeGeometry) {
                for (const [from, neighbors] of window.cotTrungPoleAdjacency.entries()) {
                    if (!mediumIndexes.has(from)) continue;
                    for (const neighbor of neighbors) {
                        if (!mediumIndexes.has(neighbor.to)) continue;
                        const pairKey = [from, neighbor.to].sort((a, b) => a - b).join(':');
                        if (drawnWirePairs.has(pairKey)) continue;
                        drawnWirePairs.add(pairKey);
                        const geometry = window.cotTrungPoleEdgeGeometry.get(`${from}-${neighbor.to}`);
                        if (!Array.isArray(geometry) || geometry.length < 2) continue;
                        poleLinksLayer.addLayer(L.polyline(geometry, {
                            color: '#ff8c00',
                            weight: 2,
                            opacity: 0.85,
                            dashArray: '6,6',
                            interactive: false
                        }));
                    }
                }
            }
        }

        function interpolatePoint(a, b, t) {
            return [a[0] + ((b[0] - a[0]) * t), a[1] + ((b[1] - a[1]) * t)];
        }

        function projectPointToSegment(point, a, b) {
            const ax = a[1], ay = a[0];
            const bx = b[1], by = b[0];
            const px = point[1], py = point[0];
            const dx = bx - ax;
            const dy = by - ay;
            const denom = (dx * dx) + (dy * dy);
            if (denom === 0) {
                const distKm = calculateDistance(point[0], point[1], a[0], a[1]);
                return { t: 0, point: [a[0], a[1]], distKm };
            }
            let t = (((px - ax) * dx) + ((py - ay) * dy)) / denom;
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            const proj = interpolatePoint(a, b, t);
            const distKm = calculateDistance(point[0], point[1], proj[0], proj[1]);
            return { t, point: proj, distKm };
        }

        function buildPolylineMetrics(coords) {
            const cumulative = [0];
            let totalKm = 0;
            for (let i = 1; i < coords.length; i++) {
                totalKm += calculateDistance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
                cumulative.push(totalKm);
            }
            return { cumulative, totalKm };
        }

        function projectPointToPolyline(point, coords, metrics = null) {
            if (!coords || coords.length < 2) return null;
            const lineMetrics = metrics || buildPolylineMetrics(coords);
            let best = null;
            for (let i = 1; i < coords.length; i++) {
                const seg = projectPointToSegment(point, coords[i - 1], coords[i]);
                const kmAlong = lineMetrics.cumulative[i - 1] + (calculateDistance(coords[i - 1][0], coords[i - 1][1], seg.point[0], seg.point[1]));
                if (!best || seg.distKm < best.distKm) {
                    best = { distKm: seg.distKm, point: seg.point, segmentIndex: i - 1, t: seg.t, kmAlong, totalKm: lineMetrics.totalKm };
                }
            }
            return best;
        }

        function slicePolylineBetween(coords, startKm, endKm) {
            if (!coords || coords.length < 2) return [];
            if (endKm < startKm) {
                const rev = slicePolylineBetween(coords, endKm, startKm);
                return rev.slice().reverse();
            }
            const metrics = buildPolylineMetrics(coords);
            const total = metrics.totalKm;
            const fromKm = Math.max(0, Math.min(total, startKm));
            const toKm = Math.max(0, Math.min(total, endKm));
            const out = [];

            const pointAtKm = (targetKm) => {
                if (targetKm <= 0) return coords[0];
                if (targetKm >= total) return coords[coords.length - 1];
                for (let i = 1; i < coords.length; i++) {
                    const prev = metrics.cumulative[i - 1];
                    const next = metrics.cumulative[i];
                    if (targetKm <= next) {
                        const segLen = next - prev;
                        const t = segLen === 0 ? 0 : (targetKm - prev) / segLen;
                        return interpolatePoint(coords[i - 1], coords[i], t);
                    }
                }
                return coords[coords.length - 1];
            };

            out.push(pointAtKm(fromKm));
            for (let i = 1; i < coords.length - 1; i++) {
                const km = metrics.cumulative[i];
                if (km > fromKm && km < toKm) out.push(coords[i]);
            }
            const endPt = pointAtKm(toKm);
            const last = out[out.length - 1];
            if (!last || calculateDistance(last[0], last[1], endPt[0], endPt[1]) > 0.000001) out.push(endPt);
            return out;
        }

        function findMediumLineGeometryBetweenPoints(fromCoords, toCoords, maxSnapKm = 0.06, snapOptions = {}) {
            if (!Array.isArray(fromCoords) || !Array.isArray(toCoords)) return null;
            const fromMaxSnapKm = Number.isFinite(snapOptions.fromMaxSnapKm) ? snapOptions.fromMaxSnapKm : maxSnapKm;
            const toMaxSnapKm = Number.isFinite(snapOptions.toMaxSnapKm) ? snapOptions.toMaxSnapKm : maxSnapKm;
            let best = null;
            (cotTrungLineGeometries || []).forEach((line, lineIndex) => {
                const coords = Array.isArray(line) ? line : line && line.coords;
                if (!Array.isArray(coords) || coords.length < 2) return;
                const metrics = buildPolylineMetrics(coords);
                const fromProjection = projectPointToPolyline(fromCoords, coords, metrics);
                const toProjection = projectPointToPolyline(toCoords, coords, metrics);
                if (!fromProjection || !toProjection) return;
                if (fromProjection.distKm > fromMaxSnapKm || toProjection.distKm > toMaxSnapKm) return;
                const geometry = slicePolylineBetween(coords, fromProjection.kmAlong, toProjection.kmAlong);
                if (!Array.isArray(geometry) || geometry.length < 2) return;
                const score = fromProjection.distKm + toProjection.distKm;
                if (!best || score < best.score) {
                    best = {
                        geometry,
                        lineIndex,
                        score,
                        fromDistanceKm: fromProjection.distKm,
                        toDistanceKm: toProjection.distKm
                    };
                }
            });
            return best;
        }

        function collectVirtualRouteEdges(checkedRouteIds) {
            const extraEdges = [];
            const attachedKeys = new Set();
            const candidateNodes = [];
            const seenNodeIds = new Set();
            const SNAP_TO_ROUTE_KM = 0.02; // ~20m

            checkedRouteIds.forEach(rid => {
                const nds = nodesByRoute.get(rid) || [];
                nds.forEach(n => {
                    if (!n || n.id == null || seenNodeIds.has(n.id)) return;
                    const coord = getNodeCoordinatesSimple(n);
                    if (!coord) return;
                    seenNodeIds.add(n.id);
                    candidateNodes.push({ id: n.id, coord, raw: n });
                });
            });

            checkedRouteIds.forEach(rid => {
                const segs = segsByRoute.get(rid) || [];
                segs.forEach(s => {
                    const a = s.startdeviceid;
                    const b = s.enddeviceid;
                    const coords = parseLatLngString(s.latlng);
                    if (a == null || b == null || !coords || coords.length < 2) return;

                    const attachments = [];
                    candidateNodes.forEach(node => {
                        if (node.id === a || node.id === b) return;
                        const attachKey = `${rid}:${a}:${b}:${node.id}`;
                        if (attachedKeys.has(attachKey)) return;
                        const proj = projectPointToPolyline(node.coord, coords);
                        if (!proj || proj.distKm > SNAP_TO_ROUTE_KM) return;
                        attachedKeys.add(attachKey);
                        attachments.push({ id: node.id, kmAlong: proj.kmAlong, point: proj.point });
                    });
                    if (!attachments.length) return;

                    attachments.sort((x, y) => x.kmAlong - y.kmAlong);
                    const chain = [{ id: a, kmAlong: 0 }, ...attachments, { id: b, kmAlong: buildPolylineMetrics(coords).totalKm }];
                    for (let i = 0; i < chain.length - 1; i++) {
                        const left = chain[i];
                        const right = chain[i + 1];
                        if (left.id == null || right.id == null || left.id === right.id) continue;
                        const subCoords = slicePolylineBetween(coords, left.kmAlong, right.kmAlong);
                        if (!subCoords || subCoords.length < 2) continue;
                        extraEdges.push({ a: left.id, b: right.id, coords: subCoords });
                    }
                });
            });

            return extraEdges;
        }

        function collectEndpointBridgeEdges(checkedRouteIds) {
            const BRIDGE_GAP_KM = 0.12; // ~120m coordinate-error tolerance for ring endpoints
            const realDegree = new Map();
            const nodeCoordMap = new Map();
            const nodeRouteMap = new Map();
            const bridges = [];
            const bridgeSeen = new Set();

            const addDegree = (id) => {
                if (id == null) return;
                realDegree.set(id, (realDegree.get(id) || 0) + 1);
            };

            checkedRouteIds.forEach(rid => {
                const nds = nodesByRoute.get(rid) || [];
                nds.forEach(n => {
                    if (!n || n.id == null) return;
                    const coord = getNodeCoordinatesSimple(n);
                    if (!coord) return;
                    if (!nodeCoordMap.has(n.id)) nodeCoordMap.set(n.id, coord);
                    if (!nodeRouteMap.has(n.id)) nodeRouteMap.set(n.id, new Set());
                    nodeRouteMap.get(n.id).add(rid);
                });

                const segs = segsByRoute.get(rid) || [];
                segs.forEach(s => {
                    const coords = parseLatLngString(s.latlng);
                    if (!coords || !coords.length) return;
                    if (s.startdeviceid != null) {
                        addDegree(s.startdeviceid);
                        if (!nodeCoordMap.has(s.startdeviceid)) nodeCoordMap.set(s.startdeviceid, coords[0]);
                        if (!nodeRouteMap.has(s.startdeviceid)) nodeRouteMap.set(s.startdeviceid, new Set());
                        nodeRouteMap.get(s.startdeviceid).add(rid);
                    }
                    if (s.enddeviceid != null) {
                        addDegree(s.enddeviceid);
                        if (!nodeCoordMap.has(s.enddeviceid)) nodeCoordMap.set(s.enddeviceid, coords[coords.length - 1]);
                        if (!nodeRouteMap.has(s.enddeviceid)) nodeRouteMap.set(s.enddeviceid, new Set());
                        nodeRouteMap.get(s.enddeviceid).add(rid);
                    }
                });
            });

            const candidates = [];
            for (const [id, coord] of nodeCoordMap.entries()) {
                const degree = realDegree.get(id) || 0;
                if (degree > 2) continue;
                candidates.push({ id, coord, degree, routes: nodeRouteMap.get(id) || new Set() });
            }
            if (candidates.length < 2) return bridges;

            const approxBucketDeg = BRIDGE_GAP_KM / 111;
            const buckets = new Map();
            const bucketKey = (coord) => `${Math.round(coord[0] / approxBucketDeg)}:${Math.round(coord[1] / approxBucketDeg)}`;

            candidates.forEach(c => {
                const key = bucketKey(c.coord);
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(c);
            });

            const neighborOffsets = [-1, 0, 1];
            const routesOverlap = (a, b) => {
                for (const rid of a.routes) {
                    if (b.routes.has(rid)) return true;
                }
                return false;
            };

            candidates.forEach(a => {
                const baseLat = Math.round(a.coord[0] / approxBucketDeg);
                const baseLng = Math.round(a.coord[1] / approxBucketDeg);
                neighborOffsets.forEach(dx => {
                    neighborOffsets.forEach(dy => {
                        const arr = buckets.get(`${baseLat + dx}:${baseLng + dy}`) || [];
                        arr.forEach(b => {
                            if (!b || a.id === b.id) return;
                            const ordered = [a.id, b.id].sort().join(':');
                            if (bridgeSeen.has(ordered)) return;
                            bridgeSeen.add(ordered);
                            if (!routesOverlap(a, b)) return;
                            const d = calculateDistance(a.coord[0], a.coord[1], b.coord[0], b.coord[1]);
                            if (d <= 0 || d > BRIDGE_GAP_KM) return;
                            bridges.push({ a: a.id, b: b.id, coords: [a.coord, b.coord], virtual: 'gap-bridge', km: d });
                        });
                    });
                });
            });

            if (bridges.length) console.log('Bridged small endpoint gaps:', bridges.length);
            return bridges;
        }

        function collectEquivalentNodeEdges(checkedRouteIds) {
            const groups = new Map();
            const edges = [];
            const seen = new Set();
            const normalizeName = (str) => String(str || '')
                .replace(/\s+/g, '')
                .replace(/\.\d+.*/, '')
                .toUpperCase();

            checkedRouteIds.forEach(rid => {
                const nds = nodesByRoute.get(rid) || [];
                nds.forEach(n => {
                    if (!n || n.id == null) return;
                    const coord = getNodeCoordinatesSimple(n);
                    if (!coord) return;
                    const coordKey = `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
                    const nameKey = normalizeName(n.name || n.code || '');
                    const key = `${coordKey}|${nameKey || 'NO_NAME'}`;
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key).push({ id: n.id, routeId: rid, coord });
                });
            });

            for (const arr of groups.values()) {
                if (arr.length < 2) continue;
                for (let i = 0; i < arr.length; i++) {
                    for (let j = i + 1; j < arr.length; j++) {
                        const a = arr[i], b = arr[j];
                        if (a.routeId === b.routeId) continue;
                        const key = [a.id, b.id].sort().join('|');
                        if (seen.has(key)) continue;
                        seen.add(key);
                        edges.push({ a: a.id, b: b.id, coords: [a.coord, b.coord], virtual: 'equivalent-node' });
                    }
                }
            }
            return edges;
        }

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
            for (let i = 0; i < poles.length; i++) adj.set(i, []);
            const hasMediumWireGeometry = Array.isArray(cotTrungLineGeometries) && cotTrungLineGeometries.length > 0;
            const mediumFallbackThresholdKm = 0.18;
            const mediumFallbackNeighbors = 4;
            const gridSizeDeg = 0.0015;
            const buckets = new Map();
            const bucketKey = (lat, lng) => `${Math.floor(lat / gridSizeDeg)}:${Math.floor(lng / gridSizeDeg)}`;
            const addBucket = (key, index) => {
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(index);
            };

            // Use a spatial grid instead of comparing every pair. The selected
            // district files contain thousands of poles, so an all-pairs scan
            // freezes the browser before routing can start.
            poles.forEach((pole, index) => {
                if (!pole || !Number.isFinite(pole.lat) || !Number.isFinite(pole.lng)) return;
                addBucket(bucketKey(pole.lat, pole.lng), index);
            });

            const addEdge = (a, b, cost) => {
                if (!Number.isFinite(cost) || cost <= 0) return;
                if (!adj.get(a).some(edge => edge.to === b)) adj.get(a).push({ to: b, cost });
                if (!adj.get(b).some(edge => edge.to === a)) adj.get(b).push({ to: a, cost });
            };

            for (let i = 0; i < poles.length; i++) {
                const pole = poles[i];
                if (!pole || !Number.isFinite(pole.lat) || !Number.isFinite(pole.lng)) continue;
                const poleIMedium = isMediumPoleRecord(pole);
                const nearby = [];
                const baseLat = Math.floor(pole.lat / gridSizeDeg);
                const baseLng = Math.floor(pole.lng / gridSizeDeg);
                for (let dx = -2; dx <= 2; dx++) {
                    for (let dy = -2; dy <= 2; dy++) {
                        const indexes = buckets.get(`${baseLat + dx}:${baseLng + dy}`) || [];
                        indexes.forEach(j => {
                            if (j === i) return;
                            const other = poles[j];
                            if (!other) return;
                            const poleJMedium = isMediumPoleRecord(other);
                            const bothMedium = poleIMedium && poleJMedium;
                            // When a line file is loaded it is the source of
                            // truth. Without one, connect nearby medium poles
                            // so the point can travel through the pole network.
                            if (bothMedium && hasMediumWireGeometry) return;
                            const connectThresholdKm = bothMedium ? mediumFallbackThresholdKm : ((poleIMedium || poleJMedium) ? 0.02 : 0.08);
                            const distanceKm = calculateDistance(pole.lat, pole.lng, other.lat, other.lng);
                            if (distanceKm <= connectThresholdKm) nearby.push({ index: j, cost: distanceKm, bothMedium });
                        });
                    }
                }

                // Keep all short regular-network links. For medium-only data,
                // retain the nearest few links per pole to avoid false jumps at
                // crossings while still keeping each physical branch connected.
                const mediumOnly = nearby.filter(edge => edge.bothMedium).sort((a, b) => a.cost - b.cost);
                const otherEdges = nearby.filter(edge => !edge.bothMedium);
                mediumOnly.slice(0, mediumFallbackNeighbors).forEach(edge => addEdge(i, edge.index, edge.cost));
                otherEdges.forEach(edge => addEdge(i, edge.index, edge.cost));
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
            const s = ('' + typeValue).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s_-]+/g, '');
            if (s === 'pop' || s === 'pops') return 'pop';
            if (s.includes('cabinet') || s === 'tu' || s.includes('tudau') || s.includes('tudau nhay')) return 'cabinet';
            if (s.includes('mangxong') || s.includes('splice')) return 'splice';
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
                if (Array.isArray(nds) && nds.length) {
                    nds.forEach(n => {
                        if (!n || n.id == null) return;
                        n.localId = normalizeNodeLocalId(n.id);
                        n.routeId = rid;
                        n.id = makeScopedNodeId(rid, n.localId);
                        nodeByScopedId.set(n.id, n);
                    });
                    nodes.push(...nds);
                }
                segs.forEach(s => {
                    s.routeId = rid;
                    s.rawStartdeviceid = normalizeNodeLocalId(s.startdeviceid);
                    s.rawEnddeviceid = normalizeNodeLocalId(s.enddeviceid);
                    s.startdeviceid = makeScopedNodeId(rid, s.rawStartdeviceid);
                    s.enddeviceid = makeScopedNodeId(rid, s.rawEnddeviceid);
                });
                segsByRoute.set(rid, segs);
                nodesByRoute.set(rid, nds);
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
                    const repairedCoords = repairRouteSegmentEndpoints(coords, s.startdeviceid, s.enddeviceid);
                    const pl = L.polyline(repairedCoords, { color: '#6a1b9a', weight: 3, opacity: 0.95 });
                    pl.bindTooltip(`${rid} - ${s.name || ''}`);
                    dataLayer.addLayer(pl);
                    repairedCoords.forEach(c => bounds.push(c));
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
            // Show the same small endpoint repairs used by the routing graph,
            // so a ring does not look broken while its source segments are
            // being rendered independently.
            collectEndpointBridgeEdges(checked).forEach(e => {
                if (!e.coords || e.coords.length < 2) return;
                dataLayer.addLayer(L.polyline(e.coords, { color: '#6a1b9a', weight: 3, opacity: 0.95 }));
                e.coords.forEach(c => bounds.push(c));
            });
            if (bounds.length) try { map.fitBounds(bounds); } catch (e) { }
        }

        function repairRouteSegmentEndpoints(coords, startId, endId) {
            if (!Array.isArray(coords) || coords.length < 2) return coords;
            const repaired = coords.slice();
            const endpoints = [
                { id: startId, side: 'start' },
                { id: endId, side: 'end' }
            ];
            endpoints.forEach(({ id, side }) => {
                const nodeCoord = getNodeCoordinatesSimple(findNodeById(id));
                if (!nodeCoord) return;
                const index = side === 'start' ? 0 : repaired.length - 1;
                const gapKm = calculateDistance(repaired[index][0], repaired[index][1], nodeCoord[0], nodeCoord[1]);
                if (gapKm <= 0.000001 || gapKm > 0.12) return;
                if (side === 'start') repaired.unshift(nodeCoord);
                else repaired.push(nodeCoord);
            });
            return repaired;
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
            let routeCount = 0;

            try {
                const r = await fetch('./data/getroute.json');
                const jr = await r.json();
                const entries = (jr && jr.table) ? jr.table : [];
                routeCount = entries.length;
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
                    cb.addEventListener('change', () => { drawSelectedRoutes(); updateSelectionSummaries(); });
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
                    cb.addEventListener('change', () => { rebuildPolesFromSelection(); updateSelectionSummaries(); });
                } catch (e) {
                    const label = document.createElement('div'); label.textContent = `${src.key}: error`; poleCheckboxes.appendChild(label);
                }
            }
            statusEl.textContent = `Loaded ${routeCount} routes · Loaded ${poleSetsData.size} pole sets`;
            // attach select/clear handlers to redraw
            document.getElementById('selectAllRoutes').addEventListener('click', () => { Array.from(routeCheckboxes.querySelectorAll('input')).forEach(i => i.checked = true); drawSelectedRoutes(); updateSelectionSummaries(); });
            document.getElementById('clearAllRoutes').addEventListener('click', () => { Array.from(routeCheckboxes.querySelectorAll('input')).forEach(i => i.checked = false); drawSelectedRoutes(); updateSelectionSummaries(); });
            document.getElementById('selectAllPolesets').addEventListener('click', () => { Array.from(poleCheckboxes.querySelectorAll('input')).forEach(i => i.checked = true); rebuildPolesFromSelection(); updateSelectionSummaries(); });
            document.getElementById('clearAllPolesets').addEventListener('click', () => { Array.from(poleCheckboxes.querySelectorAll('input')).forEach(i => i.checked = false); rebuildPolesFromSelection(); updateSelectionSummaries(); });
            // Load cot trung the manifest (optional)
            try { loadCotTrungManifest(); } catch (e) { console.warn('loadCotTrungManifest failed', e); }
            updateSelectionSummaries();
        }

        document.addEventListener('DOMContentLoaded', () => {
            enhanceBootstrapUI();
            setupSelectorPopups();
            window.__routesLoadPromise = loadRoutesAndPoles();
            document.getElementById('selectAllRoutes').addEventListener('click', () => { Array.from(routeCheckboxes.querySelectorAll('input')).forEach(i => i.checked = true); drawSelectedRoutes(); updateSelectionSummaries(); });
            document.getElementById('clearAllRoutes').addEventListener('click', () => { Array.from(routeCheckboxes.querySelectorAll('input')).forEach(i => i.checked = false); drawSelectedRoutes(); updateSelectionSummaries(); });
            document.getElementById('selectAllPolesets').addEventListener('click', () => { Array.from(poleCheckboxes.querySelectorAll('input')).forEach(i => i.checked = true); rebuildPolesFromSelection(); updateSelectionSummaries(); });
            document.getElementById('clearAllPolesets').addEventListener('click', () => { Array.from(poleCheckboxes.querySelectorAll('input')).forEach(i => i.checked = false); rebuildPolesFromSelection(); updateSelectionSummaries(); });
        });

        // Show candidates button (trigger modal for current start/end)
        const showCandidatesBtn = document.getElementById('showCandidatesBtn');
        if (showCandidatesBtn) {
            showCandidatesBtn.addEventListener('click', async () => {
                const startInputValue = document.getElementById('startCoordinateInput')?.value.trim();
                const endInputValue = document.getElementById('endCoordinateInput')?.value.trim();
                if ((!startPointCoords || !endPointCoords) && startInputValue && endInputValue) {
                    try {
                        await applyCoordinateInputs();
                    } catch (e) {
                        showRouteAlert('danger', `Khong nap duoc toa do: ${(e && e.message) ? e.message : 'Khong xac dinh'}`);
                        return;
                    }
                }
                if (!startPointCoords || !endPointCoords) {
                    showRouteAlert('warning', 'Vui long chon diem dau va diem cuoi truoc khi tim duong.');
                    return;
                    alert('Vui lòng chọn điểm đầu và điểm cuối trước (📍 Lấy tọa độ).');
                    return;
                }
                const selectedRouteCount = routeCheckboxes.querySelectorAll('input:checked').length;
                if (!selectedRouteCount) {
                    showRouteAlert('warning', 'Vui long mo "Mo danh sach" o muc Tuyen duong va chon it nhat mot tuyen ring.');
                    return;
                }
                resetRouteRunDebug({
                    startPointCoords,
                    endPointCoords,
                    selectedRoutes: Array.from(routeCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value),
                    selectedPoleSets: Array.from(poleCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value)
                });
                appendRouteRunDebug('startNearbyCandidates-pre', startNearbyCandidates);
                appendRouteRunDebug('endNearbyCandidates-pre', endNearbyCandidates);
                window.__lastTopResults = [];
                setRouteLoading(true, 'Dang tim duong', 'He thong dang tinh tuyen toi uu va kiem tra duong di tren cot dien.');
                try {
                    // attempt to recompute using existing selected routes/poles
                    await findAndDrawNetworkPaths();
                    appendRouteRunDebug('lastTopResults', window.__lastTopResults || []);
                    await flushRouteRunDebug((window.__lastTopResults && window.__lastTopResults.length) ? 'success' : 'no-results');
                } catch (e) {
                    appendRouteRunDebug('route-run-error', { message: e && e.message, stack: e && e.stack });
                    await flushRouteRunDebug('error');
                    showRouteAlert('danger', `Co loi khi tim duong: ${(e && e.message) ? e.message : 'Khong xac dinh'}`);
                    return;
                } finally {
                    setRouteLoading(false);
                }
                if (window.__lastTopResults && window.__lastTopResults.length) {
                    const bestRoute = window.__lastTopResults[0];
                    const totalKm = Number.isFinite(bestRoute && bestRoute.totalScoreKm) ? bestRoute.totalScoreKm : Number(bestRoute && bestRoute.networkKm);
                    const distanceText = Number.isFinite(totalKm) ? ` Tuyen tot nhat dai ${totalKm.toFixed(3)} km.` : '';
                    showRouteAlert('success', `Da tim thay ${window.__lastTopResults.length} phuong an.${distanceText}`);
                    renderTopResults(window.__lastTopResults);
                } else {
                    showRouteAlert('warning', 'Khong tim thay duong di phu hop. Ban hay kiem tra lai tuyen ring va bo cot da chon.');
                    return;
                    alert('Không có kết quả nào. Vui lòng kiểm tra các tuyến đã chọn.');
                }
            });
        }
        // Coordinate button behaviour
        const coordBtn = document.getElementById('getCoordinatesBtn');
        const clearBtn = document.getElementById('clearClickMarker');
        const applyCoordinatesBtn = document.getElementById('applyCoordinatesBtn');
        const cableLengthInput = document.getElementById('cableLengthInput');
        if (cableLengthInput) cableLengthInput.addEventListener('input', updateEndpointRadiusInfo);
        if (applyCoordinatesBtn) applyCoordinatesBtn.addEventListener('click', applyCoordinatesAndFindRoute);
        ['startCoordinateInput', 'endCoordinateInput'].forEach(id => {
            const input = document.getElementById(id);
            if (input) input.addEventListener('keydown', event => {
                if (event.key === 'Enter') applyCoordinatesAndFindRoute();
            });
        });
        if (coordBtn) {
            coordBtn.addEventListener('click', async () => {
                if (!isCoordinateMode) {
                    if (!getEndpointSearchRadiusKm()) return;
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
                try { nearbyStartLayer.clearLayers(); nearbyEndLayer.clearLayers(); } catch (e) { }
                try { walkingRoutesLayer.clearLayers(); } catch (e) { }
                try { routeLabelsLayer.clearLayers(); } catch (e) { }
                startPointCoords = null; endPointCoords = null;
                const startInput = document.getElementById('startCoordinateInput');
                const endInput = document.getElementById('endCoordinateInput');
                if (startInput) startInput.value = '';
                if (endInput) endInput.value = '';
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
                        coordinateToNodeId.set(`${n.routeId}|${key}`, n.id);
                    }
                }
                const rawName = (n.name || n.code || '').toString();
                if (rawName) {
                    const norm = rawName.replace(/\s+/g, '').replace(/\.\d+.*/, '').toUpperCase();
                    if (norm) nameToNodeId.set(`${n.routeId}|${norm}`, n.id);
                }
            });

            const normalizeName = (str) => String(str || '').replace(/\s+/g, '').replace(/\.\d+.*/, '').toUpperCase();

            // Resolve each missing endpoint while scanning segments once. The previous
            // implementation scanned every segment once per missing ID and could freeze
            // the browser when all routes were loaded for coordinate picking.
            segments.forEach(s => {
                if (!s || !s.latlng) return;
                const coords = parseLatLngString(s.latlng);
                if (!coords.length) return;
                const endpointInfo = [
                    {
                        id: s.startdeviceid,
                        coordKey: `${coords[0][0].toFixed(6)},${coords[0][1].toFixed(6)}`,
                        name: s.startdevicename
                    },
                    {
                        id: s.enddeviceid,
                        coordKey: `${coords[coords.length - 1][0].toFixed(6)},${coords[coords.length - 1][1].toFixed(6)}`,
                        name: s.enddevicename
                    }
                ];
                endpointInfo.forEach(endpoint => {
                    if (!endpoint.id || canonicalNodeIds.has(endpoint.id) || nodeIdMap.has(endpoint.id)) return;
                    const coordinateKey = `${s.routeId}|${endpoint.coordKey}`;
                    const nameKey = `${s.routeId}|${normalizeName(endpoint.name)}`;
                    const matchedId = coordinateToNodeId.get(coordinateKey) || (endpoint.name && nameToNodeId.get(nameKey));
                    if (matchedId != null) nodeIdMap.set(endpoint.id, matchedId);
                });
            });

            // apply mappings to segments
            segments.forEach(s => {
                if (s.startdeviceid && nodeIdMap.has(s.startdeviceid)) s.startdeviceid = nodeIdMap.get(s.startdeviceid);
                if (s.enddeviceid && nodeIdMap.has(s.enddeviceid)) s.enddeviceid = nodeIdMap.get(s.enddeviceid);

                // Some ring exports reuse the same device ID for both ends of
                // a LineString even though the final coordinate is another
                // real node. Example: TNNR000182/CO is labelled TNNP041 ->
                // TNNP041, but its final coordinate is TNNP030. Correct only
                // large metadata/geometry mismatches using a nearby node from
                // the same route; ordinary small coordinate drift is left
                // untouched and is handled by the display bridge logic.
                const ENDPOINT_REMAP_TRIGGER_KM = 0.12;
                const ENDPOINT_REMAP_MAX_KM = 0.12;
                const routeNodes = nodesByRoute.get(s.routeId) || [];
                const endpointChecks = [
                    { field: 'startdeviceid', coord: parseLatLngString(s.latlng)[0] },
                    { field: 'enddeviceid', coord: parseLatLngString(s.latlng).slice(-1)[0] }
                ];
                endpointChecks.forEach(({ field, coord }) => {
                    if (!Array.isArray(coord) || coord.length < 2) return;
                    const declaredNode = findNodeById(s[field]);
                    const declaredCoord = getNodeCoordinatesSimple(declaredNode);
                    if (!declaredCoord) return;
                    const declaredGapKm = calculateDistance(coord[0], coord[1], declaredCoord[0], declaredCoord[1]);
                    if (declaredGapKm <= ENDPOINT_REMAP_TRIGGER_KM) return;
                    let nearest = null;
                    routeNodes.forEach(candidate => {
                        if (!candidate || candidate.id === s[field]) return;
                        const candidateCoord = getNodeCoordinatesSimple(candidate);
                        if (!candidateCoord) return;
                        const distanceKm = calculateDistance(coord[0], coord[1], candidateCoord[0], candidateCoord[1]);
                        if (distanceKm > ENDPOINT_REMAP_MAX_KM) return;
                        if (!nearest || distanceKm < nearest.distanceKm) nearest = { candidate, distanceKm };
                    });
                    if (nearest) {
                        const previousId = s[field];
                        s[field] = nearest.candidate.id;
                        if (field === 'startdeviceid') s.startdevicename = nearest.candidate.name || nearest.candidate.code || s.startdevicename;
                        else s.enddevicename = nearest.candidate.name || nearest.candidate.code || s.enddevicename;
                        console.warn('Corrected ring segment endpoint from geometry', {
                            segmentId: s.id,
                            field,
                            previousId,
                            correctedId: nearest.candidate.id,
                            declaredGapKm,
                            correctedGapKm: nearest.distanceKm
                        });
                    }
                });
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
            // Keep the map responsive when a dense area contains thousands of nodes.
            return out.slice(0, 200);
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
                        fallback.push({ type: 'node', id: n.id, name: n.name || n.code || '', lat: c[0], lng: c[1], dist: d, routeId: n.routeId || null, nodeType: n.type });
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
        const ENDPOINT_RADIUS_RATIO = 0.05;

        function getEndpointSearchRadiusKm(showError = true) {
            const input = document.getElementById('cableLengthInput');
            const cableLengthMeters = Number(input && input.value);
            if (!Number.isFinite(cableLengthMeters) || cableLengthMeters <= 0) {
                if (showError) showRouteAlert('warning', 'Hay nhap chieu dai day lon hon 0 m de tinh ban kinh quet.');
                return null;
            }
            return cableLengthMeters * ENDPOINT_RADIUS_RATIO / 1000;
        }

        function getPoleSnapRadiusKm() {
            // The same 5% radius is used for node and pole lookup. There is no
            // hidden fixed-radius fallback, so an empty cable length cannot
            // accidentally select a distant pole.
            const radiusKm = getEndpointSearchRadiusKm(false);
            return Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : 0;
        }

        function updateEndpointRadiusInfo() {
            const info = document.getElementById('endpointRadiusInfo');
            const radiusKm = getEndpointSearchRadiusKm(false);
            if (!info) return;
            if (!radiusKm) {
                info.textContent = 'Nhap chieu dai day de tinh ban kinh diem dau/cuoi.';
                return;
            }
            info.textContent = `Ban kinh quet diem dau/cuoi: ${(radiusKm * 1000).toFixed(1)} m (5%)`;
        }

        function parseCoordinateInput(value) {
            const parts = String(value || '').trim().split(/[;,\s]+/).filter(Boolean);
            if (parts.length !== 2) return null;
            const lat = Number(parts[0]);
            const lng = Number(parts[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
            return [lat, lng];
        }

        async function applyCoordinateInputs() {
            const startInput = document.getElementById('startCoordinateInput');
            const endInput = document.getElementById('endCoordinateInput');
            const start = parseCoordinateInput(startInput && startInput.value);
            const end = parseCoordinateInput(endInput && endInput.value);
            const radiusKm = getEndpointSearchRadiusKm();
            if (!start || !end) {
                showRouteAlert('warning', 'Hay nhap dung ca hai toa do theo dang: vi do, kinh do.');
                return;
            }
            if (!radiusKm) return;

            const applyBtn = document.getElementById('applyCoordinatesBtn');
            const routeBtn = document.getElementById('showCandidatesBtn');
            if (applyBtn) applyBtn.disabled = true;
            if (routeBtn) routeBtn.disabled = true;
            setRouteLoading(true, 'Dang nap toa do', 'Dang nap du lieu diem va tim cac node gan hai toa do.');
            try {
                if (window.__routesLoadPromise) await window.__routesLoadPromise;
                await ensureAllRoutesLoaded();
                if (!handleCoordinatePick(start[0], start[1], 'start')) return;
                if (!handleCoordinatePick(end[0], end[1], 'end')) return;
                try { map.fitBounds([start, end], { padding: [40, 40] }); } catch (e) { }
                showRouteAlert('success', 'Da nap toa do diem dau va diem cuoi. Hay bam Duong di de tinh tuyen.');
            } finally {
                setRouteLoading(false);
                if (applyBtn) applyBtn.disabled = false;
                if (routeBtn) routeBtn.disabled = false;
            }
        }

        async function applyCoordinatesAndFindRoute() {
            try {
                await applyCoordinateInputs();
                if (!startPointCoords || !endPointCoords) return;
                const selectedRouteCount = routeCheckboxes.querySelectorAll('input:checked').length;
                if (!selectedRouteCount) {
                    showRouteAlert('warning', 'Da nhan toa do. Hay chon it nhat mot tuyen ring truoc khi tim duong.');
                    return;
                }
                const routeBtn = document.getElementById('showCandidatesBtn');
                if (routeBtn) routeBtn.click();
            } catch (e) {
                showRouteAlert('danger', `Khong tim duoc duong: ${(e && e.message) ? e.message : 'Khong xac dinh'}`);
            }
        }

        function handleCoordinatePick(lat, lng, type) {
            const radiusKm = getEndpointSearchRadiusKm();
            if (!radiusKm) return false;
            if (type === 'start') {
                try { if (startPointMarker) map.removeLayer(startPointMarker); } catch (e) { }
                startPointCoords = [lat, lng];
                const startInput = document.getElementById('startCoordinateInput');
                if (startInput) startInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
                startPointMarker = L.marker([lat, lng], { title: 'Start point' }).addTo(map);
                startPointMarker.bindPopup(`<div style="font-family:monospace"><b>Start</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}</div>`).openPopup();

                // Use helper function with fallback
                try { nearbyStartLayer.clearLayers(); nearbyEndLayer.clearLayers(); } catch (err) { }
                startNearbyCandidates = findNearbyCandidatesWithFallback(lat, lng, radiusKm);
                renderNearbyPointsOnLayer(nearbyStartLayer, startNearbyCandidates, [lat, lng], radiusKm, '#1e90ff', false, false);

                coordinateModeType = 'end';
                if (coordBtn) { coordBtn.textContent = '🎯 Click chọn điểm cuối'; coordBtn.style.background = '#ffc107'; }
                return true;
            }
            if (type === 'end') {
                try { if (endPointMarker) map.removeLayer(endPointMarker); } catch (e) { }
                endPointCoords = [lat, lng];
                const endInput = document.getElementById('endCoordinateInput');
                if (endInput) endInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
                endPointMarker = L.marker([lat, lng], { title: 'End point' }).addTo(map);
                endPointMarker.bindPopup(`<div style="font-family:monospace"><b>End</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}</div>`).openPopup();

                // Use helper function with fallback
                try { nearbyEndLayer.clearLayers(); } catch (err) { }
                endNearbyCandidates = findNearbyCandidatesWithFallback(lat, lng, radiusKm);
                renderNearbyPointsOnLayer(nearbyEndLayer, endNearbyCandidates, [lat, lng], radiusKm, '#28a745', false, false);

                // Network calculation is intentionally deferred to the route button.
                // Running it here made the map freeze immediately after the second click.
                isCoordinateMode = false;
                coordinateModeType = 'start';
                if (coordBtn) { coordBtn.textContent = '📍 Lấy tọa độ'; coordBtn.style.background = '#28a745'; }
                return true;
            }
            return false;
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
            collectVirtualRouteEdges(checked).forEach(e => addEdge(e.a, e.b));
            collectEndpointBridgeEdges(checked).forEach(e => addEdge(e.a, e.b));
            collectEquivalentNodeEdges(checked).forEach(e => addEdge(e.a, e.b));
            return adjacency;
        }

        function buildEdgeGeometryMap() {
            const checked = Array.from(routeCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value);
            const edgeMap = new Map(); // key a-b -> coords
            const edgeMeta = new Map();
            const edgeKindPriority = {
                'segment': 4,
                'route-attachment': 3,
                'equivalent-node': 2,
                'endpoint-bridge': 1,
                'unknown': 0
            };
            const geometryLength = coords => {
                if (!Array.isArray(coords) || coords.length < 2) return Infinity;
                let total = 0;
                for (let i = 1; i < coords.length; i++) {
                    total += calculateDistance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
                }
                return total;
            };
            const setEdge = (a, b, coords, meta) => {
                const key = `${a}-${b}`;
                const nextMeta = meta || { kind: 'unknown' };
                const existingCoords = edgeMap.get(key);
                const existingMeta = edgeMeta.get(key);
                if (existingCoords && existingMeta) {
                    const oldPriority = edgeKindPriority[existingMeta.kind] || 0;
                    const nextPriority = edgeKindPriority[nextMeta.kind] || 0;
                    const oldLength = geometryLength(existingCoords);
                    const nextLength = geometryLength(coords);
                    // Keep the source segment over a synthetic bridge. For
                    // duplicate virtual edges, retain the shortest actual
                    // slice; this is important for self-loop LineStrings such
                    // as TNNP041 -> ... -> TNNP041.
                    if (oldPriority > nextPriority ||
                        (oldPriority === nextPriority && oldLength <= nextLength)) return;
                }
                edgeMap.set(key, coords);
                edgeMeta.set(key, nextMeta);
            };
            for (const rid of checked) {
                const segs = segsByRoute.get(rid) || [];
                segs.forEach(s => {
                    const a = s.startdeviceid; const b = s.enddeviceid;
                    if (a == null || b == null) return;
                    const coords = parseLatLngString(s.latlng);
                    if (!coords || coords.length === 0) return;
                    const repairedCoords = repairRouteSegmentEndpoints(coords, a, b);
                    setEdge(a, b, repairedCoords, { kind: 'segment', routeId: rid, segmentId: s.id });
                    setEdge(b, a, repairedCoords.slice().reverse(), { kind: 'segment', routeId: rid, segmentId: s.id });
                });
            }
            collectVirtualRouteEdges(checked).forEach(e => {
                const meta = { kind: 'route-attachment', routeId: e.routeId || null };
                setEdge(e.a, e.b, e.coords, meta);
                setEdge(e.b, e.a, e.coords.slice().reverse(), meta);
            });
            collectEndpointBridgeEdges(checked).forEach(e => {
                const meta = { kind: 'endpoint-bridge', routes: e.routes || null };
                setEdge(e.a, e.b, e.coords, meta);
                setEdge(e.b, e.a, e.coords.slice().reverse(), meta);
            });
            collectEquivalentNodeEdges(checked).forEach(e => {
                const meta = { kind: 'equivalent-node' };
                setEdge(e.a, e.b, e.coords, meta);
                setEdge(e.b, e.a, e.coords.slice().reverse(), meta);
            });
            window.routeEdgeMeta = edgeMeta;
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
            const endpointBridgeMaxKm = 0.03; // only repair small source-coordinate drift (~30m)
            const startNodeCoords = getNodeCoordinatesSimple(findNodeById(startId));
            const endNodeCoords = getNodeCoordinatesSimple(findNodeById(endId));
            let previousEnd = null;
            // draw each edge segment without per-segment tooltips
            for (let i = 0; i < path.length - 1; i++) {
                const a = path[i], b = path[i + 1];
                const coords = edgeMap.get(`${a}-${b}`);
                if (!coords || coords.length < 2) continue;
                // Some source ring files store a logical endpoint a few metres
                // away from the node coordinate. Repair that display gap only
                // on the first/last edge; never draw a long new connector.
                if (i === 0 && startNodeCoords) {
                    const gapKm = calculateDistance(startNodeCoords[0], startNodeCoords[1], coords[0][0], coords[0][1]);
                    if (gapKm > 0.000001 && gapKm <= endpointBridgeMaxKm) {
                        grp.addLayer(L.polyline([startNodeCoords, coords[0]], { color, weight, opacity }));
                        if (typeof appendRouteRunDebug === 'function') appendRouteRunDebug('ring-start-geometry-bridge', {
                            nodeId: startId,
                            gapKm,
                            maxGapKm: endpointBridgeMaxKm
                        });
                    }
                }
                // Repair small coordinate gaps between consecutive segments
                // that share a logical node but have slightly different
                // endpoint coordinates in the source files.
                if (previousEnd) {
                    const gapKm = calculateDistance(previousEnd[0], previousEnd[1], coords[0][0], coords[0][1]);
                    if (gapKm > 0.000001 && gapKm <= endpointBridgeMaxKm) {
                        grp.addLayer(L.polyline([previousEnd, coords[0]], { color, weight, opacity }));
                    }
                }
                const pl = L.polyline(coords, { color, weight, opacity });
                grp.addLayer(pl);
                previousEnd = coords[coords.length - 1];
            }
            if (previousEnd && endNodeCoords) {
                const gapKm = calculateDistance(previousEnd[0], previousEnd[1], endNodeCoords[0], endNodeCoords[1]);
                if (gapKm > 0.000001 && gapKm <= endpointBridgeMaxKm) {
                    grp.addLayer(L.polyline([previousEnd, endNodeCoords], { color, weight, opacity }));
                    if (typeof appendRouteRunDebug === 'function') appendRouteRunDebug('ring-end-geometry-bridge', {
                        nodeId: endId,
                        gapKm,
                        maxGapKm: endpointBridgeMaxKm
                    });
                }
            }
            return { km: totalKm, grp };
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

        function getIncidentRouteEdgeKinds(candidate, edgeMap) {
            if (!candidate || candidate.id == null || !edgeMap) return [];
            const prefix = `${candidate.id}-`;
            const suffix = `-${candidate.id}`;
            const kinds = [];
            const metaMap = window.routeEdgeMeta instanceof Map ? window.routeEdgeMeta : null;
            for (const key of edgeMap.keys()) {
                if (!key.startsWith(prefix) && !key.endsWith(suffix)) continue;
                kinds.push(metaMap && metaMap.has(key) ? metaMap.get(key).kind : 'unknown');
            }
            return kinds;
        }

        function preferPopEntryCandidates(candidates, edgeMap) {
            const list = (candidates || []).slice();
            const attachedPops = list
                .filter(candidate => {
                    if (Number(candidate && candidate.nodeType) !== 1) return false;
                    // A POP reached only through a generic endpoint bridge is
                    // nearby, but is not proven to lie on the selected ring.
                    const kinds = getIncidentRouteEdgeKinds(candidate, edgeMap);
                    return kinds.some(kind => kind !== 'endpoint-bridge');
                })
                .sort((a, b) => (a.dist || Infinity) - (b.dist || Infinity));
            const nearestCandidate = list
                .slice()
                .sort((a, b) => (a.dist || Infinity) - (b.dist || Infinity))[0] || null;
            const nearestPop = attachedPops[0] || null;
            const popIsCloseEnough = !!nearestPop && (
                !nearestCandidate ||
                nearestPop.id === nearestCandidate.id ||
                nearestPop.dist <= Math.max(0.05, nearestCandidate.dist * 1.5)
            );
            return {
                // Keep every candidate in the scoring pool. A POP is a
                // tie-break preference only; it must not replace a nearer
                // cabinet/splice that is the correct route entry.
                candidates: list,
                preferredPop: popIsCloseEnough,
                nearestCandidate,
                nearestPop,
                rejectedPopCount: list.filter(candidate => Number(candidate && candidate.nodeType) === 1).length - attachedPops.length
            };
        }

        function anchorCandidatesToClickedPoint(candidates, thresholdKm = 0.05) {
            if (!candidates || candidates.length === 0) return { candidates: [], anchored: false, anchor: null };
            const best = pickNearestCandidate(candidates, true);
            if (!best || !Number.isFinite(best.dist) || best.dist > thresholdKm) {
                return { candidates: candidates.slice(), anchored: false, anchor: null };
            }
            return { candidates: [best], anchored: true, anchor: best };
        }

        // layer for route labels/popups
        const routeLabelsLayer = L.layerGroup().addTo(map);

        async function findAndDrawNetworkPaths() {
            const checkedRouteIds = Array.from(routeCheckboxes.querySelectorAll('input'))
                .filter(input => input.checked)
                .map(input => input.value);
            const nearestRouteCandidates = (coords, routeIds, limit = 8) => {
                if (!Array.isArray(coords) || coords.length < 2) return [];
                const out = [];
                const seen = new Set();
                routeIds.forEach(routeId => {
                    (nodesByRoute.get(routeId) || []).forEach(node => {
                        if (!node || node.id == null) return;
                        const coord = getNodeCoordinatesSimple(node);
                        if (!coord || seen.has(node.id)) return;
                        seen.add(node.id);
                        out.push({
                            type: 'node',
                            id: node.id,
                            name: node.name || node.code || '',
                            lat: coord[0],
                            lng: coord[1],
                            dist: calculateDistance(coords[0], coords[1], coord[0], coord[1]),
                            routeId,
                            nodeType: node.type
                        });
                    });
                });
                return out.sort((a, b) => a.dist - b.dist).slice(0, limit);
            };

            // The 5% radius controls endpoint pole selection. If it contains no
            // ring node, still use the nearest selected ring node as the network
            // target; the endpoint leg remains pole-first and never becomes a
            // direct point-to-node shortcut.
            if ((!startNearbyCandidates || startNearbyCandidates.length === 0) && startPointCoords) {
                startNearbyCandidates = nearestRouteCandidates(startPointCoords, checkedRouteIds);
                appendRouteRunDebug('start-ring-node-radius-fallback', startNearbyCandidates);
            }
            if ((!endNearbyCandidates || endNearbyCandidates.length === 0) && endPointCoords) {
                endNearbyCandidates = nearestRouteCandidates(endPointCoords, checkedRouteIds);
                appendRouteRunDebug('end-ring-node-radius-fallback', endNearbyCandidates);
            }
            if (!startNearbyCandidates || !endNearbyCandidates || startNearbyCandidates.length === 0 || endNearbyCandidates.length === 0) return;
            const adjacency = buildAdjacencyForSelectedRoutes();
            const edgeMap = buildEdgeGeometryMap();
            appendRouteRunDebug('graph-summary', {
                adjacencyNodeCount: adjacency.size,
                edgeGeometryCount: edgeMap.size,
                startNearbyCount: startNearbyCandidates.length,
                endNearbyCount: endNearbyCandidates.length,
                poleCount: poles.length,
                mediumPoleCount: cotTrungActivePoles.length,
                mediumLineCount: cotTrungLineGeometries.length,
                selectedPoleSets: Array.from(poleCheckboxes.querySelectorAll('input:checked')).map(input => input.value)
            });
            console.log('Route pole graph state', {
                poleCount: poles.length,
                mediumPoleCount: cotTrungActivePoles.length,
                mediumLineCount: cotTrungLineGeometries.length,
                selectedPoleSets: Array.from(poleCheckboxes.querySelectorAll('input:checked')).map(input => input.value)
            });

            try { walkingRoutesLayer.clearLayers(); } catch (eClear) { walkingRoutesLayer = L.layerGroup().addTo(map); }

            // Build candidate lists (top N nearest) for start and end, prioritizing nearby candidates then adjacency nodes
            const sCoords = startPointCoords || (startNearbyCandidates[0] ? [startNearbyCandidates[0].lat, startNearbyCandidates[0].lng] : null);
            const eCoords = endPointCoords || (endNearbyCandidates[0] ? [endNearbyCandidates[0].lat, endNearbyCandidates[0].lng] : null);
            const endpointRadiusKm = getEndpointSearchRadiusKm(false) || 0;

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
                const nodeObj = findNodeById(id);
                if (!nodeObj || !nodeObj.latlng) continue;
                const c = getNodeCoordinatesSimple(nodeObj);
                if (!c) continue;
                if (sCoords) {
                    const ds = calculateDistance(sCoords[0], sCoords[1], c[0], c[1]);
                    // only include adjacency nodes within a sensible radius to avoid explosion
                    if (ds <= endpointRadiusKm) adjStarts.push({ id: nodeObj.id, name: nodeObj.name || nodeObj.code || '', lat: c[0], lng: c[1], dist: ds, nodeType: nodeObj.type });
                }
                if (eCoords) {
                    const de = calculateDistance(eCoords[0], eCoords[1], c[0], c[1]);
                    if (de <= endpointRadiusKm) adjEnds.push({ id: nodeObj.id, name: nodeObj.name || nodeObj.code || '', lat: c[0], lng: c[1], dist: de, nodeType: nodeObj.type });
                }
            }
            adjStarts.sort((a, b) => a.dist - b.dist);
            adjEnds.sort((a, b) => a.dist - b.dist);
            // include adjacency nodes (filtered by radius)
            startCandidates = uniqueById(startCandidates.concat(adjStarts));
            endCandidates = uniqueById(endCandidates.concat(adjEnds));
            appendRouteRunDebug('candidate-lists-expanded', {
                startCandidates,
                endCandidates
            });

            // A POP already present near an endpoint is the preferred entry
            // into the ring. Do not let a nearer MX/cabinet win only because
            // its total-distance score is slightly shorter.
            const allStartCandidates = startCandidates.slice();
            const allEndCandidates = endCandidates.slice();
            const preferredStart = preferPopEntryCandidates(startCandidates, edgeMap);
            const preferredEnd = preferPopEntryCandidates(endCandidates, edgeMap);
            startCandidates = preferredStart.candidates;
            endCandidates = preferredEnd.candidates;
            appendRouteRunDebug('pop-entry-preference', {
                preferredStartPop: preferredStart.preferredPop,
                preferredEndPop: preferredEnd.preferredPop,
                rejectedStartPopCount: preferredStart.rejectedPopCount,
                rejectedEndPopCount: preferredEnd.rejectedPopCount,
                nearestStartCandidate: preferredStart.nearestCandidate,
                nearestStartPop: preferredStart.nearestPop,
                nearestEndCandidate: preferredEnd.nearestCandidate,
                nearestEndPop: preferredEnd.nearestPop,
                startCandidateCount: startCandidates.length,
                endCandidateCount: endCandidates.length
            });

            // If candidate pairs explode, trim to nearest 10 on each side to keep computation bounded
            const PAIR_LIMIT = 200;
            if ((startCandidates.length * endCandidates.length) > PAIR_LIMIT) {
                startCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
                endCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
                startCandidates = startCandidates.slice(0, 10);
                endCandidates = endCandidates.slice(0, 10);
            }

            let fallbackStartCandidates = allStartCandidates.slice();
            let fallbackEndCandidates = allEndCandidates.slice();
            if ((fallbackStartCandidates.length * fallbackEndCandidates.length) > PAIR_LIMIT) {
                fallbackStartCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
                fallbackEndCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
                fallbackStartCandidates = fallbackStartCandidates.slice(0, 10);
                fallbackEndCandidates = fallbackEndCandidates.slice(0, 10);
            }

            if (!startCandidates.length || !endCandidates.length) {
                appendRouteRunDebug('no-candidates-after-expansion', { startCandidates, endCandidates });
                console.log('No start/end candidates after expansion');
                return;
            }

            async function estimateAccessLegKm(pointCoords, candidateNode) {
                if (!pointCoords || !candidateNode) return Infinity;
                try {
                    const poleToNode = await previewPoleRouteToNode(pointCoords[0], pointCoords[1], candidateNode.id);
                    if (poleToNode && Number.isFinite(poleToNode.km)) return poleToNode.km;
                } catch (e) {
                    console.warn('estimateAccessLegKm: previewPoleRouteToNode failed', e);
                }
                try {
                    const viaPoles = await routeViaPolesWalk(pointCoords[0], pointCoords[1], candidateNode.lat, candidateNode.lng, { computeOnly: true });
                    if (viaPoles && Number.isFinite(viaPoles.km)) return viaPoles.km;
                } catch (e) {
                    console.warn('estimateAccessLegKm: routeViaPolesWalk preview failed', e);
                }
                // Do not score a direct connector when a pole is already available
                // at the endpoint: that would make the final route ignore the pole.
                const nearbyPoles = findPoleNeighbors(pointCoords[0], pointCoords[1], getPoleSnapRadiusKm(), 1);
                if (nearbyPoles.length) return Infinity;
                // The endpoint has no usable pole path. Use the same road
                // distance that will be drawn later, so candidate ranking,
                // table totals, and the map popup all use one value.
                try {
                    const road = await drawRoadRoute(
                        pointCoords[0],
                        pointCoords[1],
                        candidateNode.lat,
                        candidateNode.lng,
                        { draw: false }
                    );
                    if (road && Number.isFinite(road.km)) return road.km;
                } catch (e) {
                    console.warn('estimateAccessLegKm: road route failed', e);
                }
                return Infinity;
            }

            async function evaluateCandidatePairs(startList, endList) {
                const results = [];
                for (const sc of startList) {
                    for (const ec of endList) {
                        if (!sc || !ec || sc.id == null || ec.id == null) continue;
                        const netRes = computeShortestNetworkPath(sc.id, ec.id, adjacency, edgeMap);
                        if (!netRes) continue;
                        const edgeMeta = window.routeEdgeMeta instanceof Map ? window.routeEdgeMeta : new Map();
                        const startPathEdgeKey = netRes.path.length > 1 ? `${netRes.path[0]}-${netRes.path[1]}` : null;
                        const endPathEdgeKey = netRes.path.length > 1 ? `${netRes.path[netRes.path.length - 2]}-${netRes.path[netRes.path.length - 1]}` : null;
                        const startPathEdgeKind = startPathEdgeKey && edgeMeta.has(startPathEdgeKey) ? edgeMeta.get(startPathEdgeKey).kind : 'unknown';
                        const endPathEdgeKind = endPathEdgeKey && edgeMeta.has(endPathEdgeKey) ? edgeMeta.get(endPathEdgeKey).kind : 'unknown';
                        // A POP may be used as an endpoint only when its first
                        // or last path edge is a real ring segment, a route
                        // attachment, or an exact equivalent node. A generic
                        // endpoint-gap bridge means the POP is merely nearby.
                        if (Number(sc.nodeType) === 1 && startPathEdgeKind === 'endpoint-bridge') continue;
                        if (Number(ec.nodeType) === 1 && endPathEdgeKind === 'endpoint-bridge') continue;
                        const networkKm = netRes.km || Infinity;
                        const accessStartKm = startPointCoords ? await estimateAccessLegKm(startPointCoords, sc) : 0;
                        const accessEndKm = endPointCoords ? await estimateAccessLegKm(endPointCoords, ec) : 0;
                        // A nearby pole with no connected pole path is not a valid
                        // candidate. Keeping Infinity here would show a ring route
                        // while silently omitting the required endpoint cable leg.
                        if (!Number.isFinite(accessStartKm) || !Number.isFinite(accessEndKm)) continue;
                        const totalScoreKm = networkKm + accessStartKm + accessEndKm;
                        results.push({
                            networkKm,
                            accessStartKm,
                            accessEndKm,
                            totalScoreKm,
                            startNode: sc,
                            endNode: ec,
                            networkRes: netRes,
                            startPathEdgeKind,
                            endPathEdgeKind
                        });
                    }
                }
                return results;
            }

            const anchoredStart = anchorCandidatesToClickedPoint(startCandidates, 0.05);
            const anchoredEnd = anchorCandidatesToClickedPoint(endCandidates, 0.05);
            appendRouteRunDebug('anchored-candidates', {
                start: anchoredStart,
                end: anchoredEnd
            });
            let allResults = await evaluateCandidatePairs(anchoredStart.candidates, anchoredEnd.candidates);

            if (!allResults.length && (anchoredStart.anchored || anchoredEnd.anchored)) {
                console.log('Anchored candidates produced no path; retrying with expanded nearby candidates.');
                appendRouteRunDebug('anchor-fallback', 'Anchored candidates produced no path; retrying with expanded nearby candidates.');
                allResults = await evaluateCandidatePairs(
                    preferredStart.preferredPop ? preferredStart.candidates : fallbackStartCandidates,
                    preferredEnd.preferredPop ? preferredEnd.candidates : fallbackEndCandidates
                );
            }

            if (!allResults.length && (preferredStart.preferredPop || preferredEnd.preferredPop)) {
                // Keep a POP fixed on the side where one exists, while allowing
                // the other side to use its nearby MX/cabinet/node candidates.
                // This handles a POP-to-non-POP connection without replacing
                // the requested POP with a closer but wrong entry node.
                console.log('POP pair produced no path; expanding the opposite side while keeping POP entry.');
                appendRouteRunDebug('pop-side-expansion', 'POP pair produced no path; expanded only the opposite side while keeping POP entry.');
                const popStartList = preferredStart.preferredPop ? preferredStart.candidates : fallbackStartCandidates;
                const popEndList = preferredEnd.preferredPop ? preferredEnd.candidates : fallbackEndCandidates;
                allResults = await evaluateCandidatePairs(popStartList, fallbackEndCandidates);
                if (!allResults.length) allResults = await evaluateCandidatePairs(fallbackStartCandidates, popEndList);
            }

            if (!allResults.length) {
                const poleRadiusKm = getPoleSnapRadiusKm();
                appendRouteRunDebug('pole-routing-diagnostic', {
                    poleSnapRadiusKm: poleRadiusKm,
                    startPoleNeighbors: startPointCoords ? getPoleNeighborGroups(startPointCoords[0], startPointCoords[1], poleRadiusKm, 12) : null,
                    endPoleNeighbors: endPointCoords ? getPoleNeighborGroups(endPointCoords[0], endPointCoords[1], poleRadiusKm, 12) : null,
                    message: 'No network candidate has a connected pole-first access leg; direct connector was disabled when a nearby pole exists.'
                });
                appendRouteRunDebug('no-network-path', {
                    startCandidates,
                    endCandidates,
                    anchoredStart,
                    anchoredEnd
                });
                console.log('No network path found among candidates');
                return;
            }
            // ưu tiên tổng chi phí gồm: chân đầu theo cột + mạng hiện hữu + chân cuối theo cột
            allResults.sort((a, b) => a.totalScoreKm - b.totalScoreKm);
            const topResults = allResults.slice(0, 10);
            const best = topResults[0];
            appendRouteRunDebug('top-results', topResults);
            appendRouteRunDebug('best-result', best);

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
                        if (!leg1) console.warn('No road route for start endpoint; skipped straight connector');
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
                        if (!leg2) console.warn('No road route for end endpoint; skipped straight connector');
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
                    const walkingKm1 = (typeof leg1 === 'object' && leg1 && Number.isFinite(leg1.km)) ? leg1.km : (Number(best.accessStartKm) || 0);
                    const walkingKm2 = (typeof leg2 === 'object' && leg2 && Number.isFinite(leg2.km)) ? leg2.km : (Number(best.accessEndKm) || 0);
                    const additionalCableKm = walkingKm1 + walkingKm2;
                    const totalKm = walkingKm1 + (best.networkKm || 0) + walkingKm2;
                    if (endPointMarker) endPointMarker.bindPopup(`<b>Tuyến mạng tốt nhất</b><br>Từ điểm đầu đến hạ tầng FTEL: ${walkingKm1.toFixed(3)} km<br>Từ điểm cuối đến hạ tầng FTEL: ${walkingKm2.toFixed(3)} km<br><b>Tổng hai đoạn nối: ${additionalCableKm.toFixed(3)} km</b><br>Mạng hiện hữu: ${(best.networkKm || 0).toFixed(3)} km<br><b>Tổng tuyến: ${totalKm.toFixed(3)} km</b>`).openPopup();
                } catch (errLeg) {
                    // fallback: just save results and popup network-only
                    try {
                        window.__lastTopResults = topResults;
                        window.__lastEdgeMap = edgeMap;
                        window.__lastAdjacency = adjacency;
                        renderTopResults(topResults);
                    } catch (e) { }
                    const fallbackAdditionalCableKm = (best.accessStartKm || 0) + (best.accessEndKm || 0);
                    const fallbackTotalKm = fallbackAdditionalCableKm + (best.networkKm || 0);
                    if (endPointMarker) endPointMarker.bindPopup(`<b>Tuyến mạng tốt nhất</b><br>Từ điểm đầu đến hạ tầng FTEL: ${(best.accessStartKm || 0).toFixed(3)} km<br>Từ điểm cuối đến hạ tầng FTEL: ${(best.accessEndKm || 0).toFixed(3)} km<br><b>Tổng hai đoạn nối: ${fallbackAdditionalCableKm.toFixed(3)} km</b><br>Mạng hiện hữu: ${best.networkKm.toFixed(3)} km<br><b>Tổng tuyến: ${fallbackTotalKm.toFixed(3)} km</b>`).openPopup();
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
            // Include the active medium-voltage pole file in the routing graph.
            if (cotTrungActivePoles.length) poles.push(...cotTrungActivePoles);
            cotTrungLineAdjacencyDirty = true;
            // Pole indexes change when a set is selected or loaded. Never reuse
            // adjacency maps built for the previous pole array.
            window.poleAdjacency = new Map();
            window.poleProximityAdj = new Map();
            window.cotTrungPoleAdjacency = new Map();
            window.cotTrungPoleEdgeGeometry = new Map();
            polesLayer.clearLayers();
            // Show lightweight dots instead of pole icons. Keep one dot for a
            // duplicate record at the same physical position.
            const renderedPoleKeys = new Set();
            poles.forEach(pole => {
                if (!pole || !Number.isFinite(pole.lat) || !Number.isFinite(pole.lng)) return;
                const poleKey = `${pole.lat.toFixed(6)},${pole.lng.toFixed(6)}|${normalizeCode(pole.code || pole.id || pole.name || '')}`;
                if (renderedPoleKeys.has(poleKey)) return;
                renderedPoleKeys.add(poleKey);
                const dot = L.circleMarker([pole.lat, pole.lng], Object.assign({}, POLE_DOT_STYLE));
                polesLayer.addLayer(dot);
            });
            try { buildPoleCodeAdjacency(); } catch (e) { console.warn('buildPoleCodeAdjacency failed', e); }
            try { rebuildCotTrungLineAdjacency(); } catch (e) { console.warn('rebuildCotTrungLineAdjacency failed', e); }
            // Draw the existing pole links after both adjacency maps are ready.
            try { drawAllPoleLinks(); } catch (e) { console.warn('drawAllPoleLinks failed', e); }
        }

        // Render top results into modal table and show it
        function getPathDeviceCounts(pathIds) {
            const counts = { pops: 0, cabinets: 0, splices: 0 };
            (pathIds || []).forEach(id => {
                const nodeObj = findNodeById(id);
                if (!nodeObj) return;
                const cls = classifyNodeType(nodeObj.type != null ? nodeObj.type : nodeObj.nodeType);
                if (cls === 'pop') counts.pops++;
                else if (cls === 'cabinet') counts.cabinets++;
                else if (cls === 'splice') counts.splices++;
            });
            return counts;
        }

        function calculate1310Loss(pathIds, totalKm) {
            const deviceCounts = getPathDeviceCounts(pathIds);
            const popsCount = deviceCounts.pops;
            const cabinetsCount = deviceCounts.cabinets;
            const nodeCount = Math.max(0, popsCount + cabinetsCount - 1);
            const couplerCount = 2 * nodeCount + 2;
            const jumperCount = nodeCount + 2;
            const pigtailCount = 2 * nodeCount + 2;
            const fusionCount = Math.ceil(totalKm / 4 + couplerCount);
            const cableLoss = 0.35 * totalKm;
            const couplerLoss = 0.30 * couplerCount;
            const fusionLoss = 0.10 * fusionCount;
            const jumperLoss = 0.30 * jumperCount;
            const pigtailLoss = 0.15 * pigtailCount;
            const loss = cableLoss + couplerLoss + fusionLoss + jumperLoss + pigtailLoss;
            return {
                ...deviceCounts,
                nodeCount,
                couplerCount,
                jumperCount,
                pigtailCount,
                fusionCount,
                loss
            };
        }

        function renderTopResults(results) {
            const body = document.getElementById('topResultsModalBody');
            const modal = document.getElementById('topResultsModal');
            if (!body || !modal) return;
            if (!results || results.length === 0) { body.innerHTML = '<div>Không tìm thấy tuyến phù hợp</div>'; modal.style.display = 'none'; return; }
            let html = '<table style="width:100%;min-width:1160px;border:1px solid #d9dee3;border-collapse:collapse;table-layout:fixed;font-family:Arial,sans-serif;font-size:12px;">';
            html += '<colgroup><col style="width:42px"><col style="width:150px"><col style="width:120px"><col style="width:150px"><col style="width:78px"><col style="width:88px"><col style="width:125px"><col style="width:115px"><col style="width:145px"><col style="width:170px"></colgroup>';
            html += '<thead><tr style="font-weight:bold;background:#f0f0f0;"><th style="padding:8px 6px;text-align:center;border:1px solid #d9dee3">#</th><th style="padding:8px 6px;text-align:left;border:1px solid #d9dee3">Điểm đầu</th><th style="padding:8px 6px;text-align:left;border:1px solid #d9dee3">Tuyến</th><th style="padding:8px 6px;text-align:left;border:1px solid #d9dee3">Điểm cuối</th><th style="padding:8px 6px;text-align:center;border:1px solid #d9dee3">POP + tủ</th><th style="padding:8px 6px;text-align:center;border:1px solid #d9dee3">Măng xông</th><th style="padding:8px 6px;text-align:right;border:1px solid #d9dee3">Cáp kéo thêm (km)</th><th style="padding:8px 6px;text-align:right;border:1px solid #d9dee3">Tổng tuyến (km)</th><th style="padding:8px 6px;text-align:right;border:1px solid #d9dee3">Suy hao toàn tuyến (dB)</th><th style="padding:8px 6px;text-align:left;border:1px solid #d9dee3">Thao tác</th></tr></thead><tbody>';
            results.forEach((r, idx) => {
                const sname = (r.startNode && (r.startNode.name || r.startNode.id)) || '';
                const ename = (r.endNode && (r.endNode.name || r.endNode.id)) || '';
                const routes = getRouteNamesForPath(r.networkRes && r.networkRes.path) || [];
                const pathIds = (r.networkRes && r.networkRes.path) ? r.networkRes.path : [];
                const deviceCounts = getPathDeviceCounts(pathIds);
                const popCabCount = deviceCounts.pops + deviceCounts.cabinets;
                const additionalCableKm = (r.accessStartKm || 0) + (r.accessEndKm || 0);
                const totalKm = Number(r.totalScoreKm || r.networkKm || 0);
                const loss1310 = calculate1310Loss(pathIds, totalKm);
                html += '<tr style="border-top:1px solid #eee;">' +
                    `<td style="padding:6px;vertical-align:middle">${idx + 1}</td>` +
                    `<td style="padding:6px;vertical-align:middle">${escapeHtml(sname)}</td>` +
                    `<td style="padding:6px;vertical-align:middle">${escapeHtml((routes.join(', ')).toString())}</td>` +
                    `<td style="padding:6px;vertical-align:middle">${escapeHtml(ename)}</td>` +
                    `<td style="padding:6px;text-align:center;vertical-align:middle">${popCabCount}</td>` +
                    `<td style="padding:6px;text-align:center;vertical-align:middle">${deviceCounts.splices}</td>` +
                    `<td style="padding:6px;text-align:right;vertical-align:middle">${additionalCableKm.toFixed(6)}</td>` +
                    `<td style="padding:6px;text-align:right;vertical-align:middle">${totalKm.toFixed(6)}</td>` +
                    `<td style="padding:6px;text-align:right;vertical-align:middle">${loss1310.loss.toFixed(3)}</td>` +
                    `<td style="padding:6px;vertical-align:middle"><button data-idx="${idx}" class="modalShowBtn" style="padding:6px 8px;margin-right:6px">Xem</button><button data-idx="${idx}" class="modalInfoBtn" style="padding:6px 8px">Thông tin</button></td>` +
                    '</tr>';
            });
            html += '</tbody></table>';
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
            const additionalCableKm = (r.accessStartKm || 0) + (r.accessEndKm || 0);
            const formatKm = value => (Number.isFinite(Number(value)) ? Number(value).toFixed(6) : '0.000000');
            const startName = r.startNode && (r.startNode.name || r.startNode.id);
            const endName = r.endNode && (r.endNode.name || r.endNode.id);
            const totalKm = r.totalScoreKm || r.networkKm || 0;
            const lossSummary = calculate1310Loss(pathIds, totalKm);
            const deviceCounts = lossSummary;
            const popsCount = deviceCounts.pops;
            const cabinetsCount = deviceCounts.cabinets;
            const splicesCount = deviceCounts.splices;
            const nodeCountForLoss = lossSummary.nodeCount;
            const couplerCount = lossSummary.couplerCount;
            const jumperCount = lossSummary.jumperCount;
            const pigtailCount = lossSummary.pigtailCount;
            const fusionCount = lossSummary.fusionCount;
            const cableLoss1310 = 0.35 * totalKm;
            const couplerLoss1310 = 0.30 * couplerCount;
            const fusionLoss1310 = 0.10 * fusionCount;
            const jumperLoss1310 = 0.30 * jumperCount;
            const pigtailLoss1310 = 0.15 * pigtailCount;
            const loss1310 = lossSummary.loss;
            const totalMeters = totalKm * 1000;
            const pointRows = pathIds.map((id, pointIndex) => {
                const nodeObj = findNodeById(id);
                const pointName = nodeObj && (nodeObj.name || nodeObj.code || nodeObj.id) || id;
                const rawType = nodeObj && (nodeObj.type != null ? nodeObj.type : nodeObj.nodeType) || '';
                const pointClass = classifyNodeType(rawType);
                const pointType = pointClass === 'pop' ? 'POP'
                    : pointClass === 'cabinet' ? 'Tủ đấu nhảy'
                        : pointClass === 'splice' ? 'Măng xông' : rawType;
                return `<tr><td style="padding:6px;border:1px solid #ddd;text-align:center;">${pointIndex + 1}</td><td style="padding:6px;border:1px solid #ddd;">${escapeHtml(pointName)}</td><td style="padding:6px;border:1px solid #ddd;">${escapeHtml(pointType)}</td></tr>`;
            }).join('');
            const pointTable = pointRows
                ? `<table style="width:100%;border-collapse:collapse;"><tr style="background:#f0f0f0;font-weight:bold;"><td style="width:45px;padding:6px;border:1px solid #ddd;text-align:center;">STT</td><td style="padding:6px;border:1px solid #ddd;">Tên point</td><td style="width:110px;padding:6px;border:1px solid #ddd;">Loại</td></tr>${pointRows}</table>`
                : '<div>Không có point trên tuyến</div>';
            const modal = document.getElementById('routeInfoModal');
            const body = document.getElementById('routeInfoModalBody');
            if (!modal || !body) return;
            body.innerHTML = `<table style="width:100%;border-collapse:collapse;table-layout:fixed;">
                <tr style="background:#f0f0f0;font-weight:bold;"><td style="width:42%;padding:8px;border:1px solid #ddd;">Hạng mục</td><td style="padding:8px;border:1px solid #ddd;">Kết quả</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd;">Ứng viên</td><td style="padding:8px;border:1px solid #ddd;">#${idx + 1}</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd;">Cột đầu tuyến</td><td style="padding:8px;border:1px solid #ddd;">${escapeHtml(startName)}</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd;">Cột cuối tuyến</td><td style="padding:8px;border:1px solid #ddd;">${escapeHtml(endName)}</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd;">Từ điểm đầu đến hạ tầng FTEL</td><td style="padding:8px;border:1px solid #ddd;text-align:right;">${formatKm(r.accessStartKm)} km</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd;">Từ điểm cuối đến hạ tầng FTEL</td><td style="padding:8px;border:1px solid #ddd;text-align:right;">${formatKm(r.accessEndKm)} km</td></tr>
                <tr style="font-weight:bold;background:#eaf6ed;"><td style="padding:8px;border:1px solid #ddd;">Tổng hai đoạn nối</td><td style="padding:8px;border:1px solid #ddd;text-align:right;">${formatKm(additionalCableKm)} km</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd;">Mạng hiện hữu</td><td style="padding:8px;border:1px solid #ddd;text-align:right;">${formatKm(r.networkKm)} km</td></tr>
                <tr style="font-weight:bold;"><td style="padding:8px;border:1px solid #ddd;">Tổng chiều dài tuyến</td><td style="padding:8px;border:1px solid #ddd;text-align:right;">${formatKm(totalKm)} km</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd;vertical-align:top;">Đường đi</td><td style="padding:8px;border:1px solid #ddd;word-break:break-word;">${escapeHtml(pathNames.join(' -> '))}</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd;vertical-align:top;">Danh sách point</td><td style="padding:8px;border:1px solid #ddd;">${pointTable}</td></tr>
            </table>
            <h4 style="margin:16px 0 8px;font-size:15px;">Tính vật tư và suy hao tại 1310 nm</h4>
            <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
                <tr style="background:#f0f0f0;font-weight:bold;"><td style="padding:7px;border:1px solid #ddd;">Loại thiết bị</td><td style="padding:7px;border:1px solid #ddd;text-align:center;">Số lượng</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">POP</td><td style="padding:7px;border:1px solid #ddd;text-align:center;">${popsCount}</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Tủ đấu nhảy (Cabinet)</td><td style="padding:7px;border:1px solid #ddd;text-align:center;">${cabinetsCount}</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Măng xông (MangXong)</td><td style="padding:7px;border:1px solid #ddd;text-align:center;">${splicesCount}</td></tr>
            </table>
            <table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-top:8px;">
                <tr style="background:#f0f0f0;font-weight:bold;"><td style="padding:7px;border:1px solid #ddd;">Thông số</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">Giá trị</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">D = tổng chiều dài tuyến</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${totalMeters.toFixed(3)} m</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">L = D / 1000</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${formatKm(totalKm)} km</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">N = P + C - 1</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${nodeCountForLoss}</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Coupler SC = 2N + 2</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${couplerCount}</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Dây nhảy = N + 2</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${jumperCount}</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Pigtail = 2N + 2</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${pigtailCount}</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Mối hàn = ceil(L / 4 + coupler)</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${fusionCount}</td></tr>
            </table>
            <table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-top:8px;">
                <tr style="background:#f0f0f0;font-weight:bold;"><td style="padding:7px;border:1px solid #ddd;">Thành phần suy hao 1310 nm</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">Suy hao</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Cáp quang (0,35 dB/km)</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${formatKm(cableLoss1310)} dB</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Coupler SC (0,30 dB/coupler)</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${formatKm(couplerLoss1310)} dB</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Mối hàn (0,10 dB/mối)</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${formatKm(fusionLoss1310)} dB</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Dây nhảy (0,30 dB/dây)</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${formatKm(jumperLoss1310)} dB</td></tr>
                <tr><td style="padding:7px;border:1px solid #ddd;">Pigtail (0,15 dB/dây)</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${formatKm(pigtailLoss1310)} dB</td></tr>
                <tr style="font-weight:bold;background:#eaf6ed;"><td style="padding:7px;border:1px solid #ddd;">Tổng suy hao SH1310</td><td style="padding:7px;border:1px solid #ddd;text-align:right;">${formatKm(loss1310)} dB</td></tr>
            </table>`;
            modal.style.display = 'block';
            const closeBtn = document.getElementById('closeRouteInfoModal');
            if (closeBtn) closeBtn.onclick = () => { modal.style.display = 'none'; };
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
                const walkingKm1 = (leg1 && Number.isFinite(leg1.km)) ? leg1.km : (Number(r.accessStartKm) || 0);
                const walkingKm2 = (leg2 && Number.isFinite(leg2.km)) ? leg2.km : (Number(r.accessEndKm) || 0);
                const additionalCableKm = walkingKm1 + walkingKm2;
                const totalKm = walkingKm1 + (r.networkKm || 0) + walkingKm2;
                if (endPointMarker) endPointMarker.bindPopup(`<b>Tuyến (ứng viên ${idx + 1})</b><br>Từ điểm đầu đến hạ tầng FTEL: ${walkingKm1.toFixed(3)} km<br>Từ điểm cuối đến hạ tầng FTEL: ${walkingKm2.toFixed(3)} km<br><b>Tổng hai đoạn nối: ${additionalCableKm.toFixed(3)} km</b><br>Mạng hiện hữu: ${(r.networkKm || 0).toFixed(3)} km<br><b>Tổng tuyến: ${totalKm.toFixed(3)} km</b>`).openPopup();
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
                    const nodeObj = findNodeById(pid);
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
