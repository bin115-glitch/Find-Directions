// ========== Data Loading Functions ==========

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
            marker.bindPopup(`<b>Node</b><br>Name: ${n.name || n.code || n.id}<br>ID: ${n.id}<br>Type: ${cls}<br>Coordinate: ${coord[0].toFixed(6)}, ${coord[1].toFixed(6)}`);
            dataLayer.addLayer(marker);
            bounds.push(coord);
        });
    }
    if (bounds.length) try { map.fitBounds(bounds); } catch (e) { }
}

// Load route list and pole sets for UI
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
    // Load cot trung the manifest (optional) - only if function exists in load_data_only.js
    try {
        if (typeof loadCotTrungManifest === 'function') {
            loadCotTrungManifest();
        }
    } catch (e) {
        console.warn('loadCotTrungManifest not available or failed', e);
    }
}

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
