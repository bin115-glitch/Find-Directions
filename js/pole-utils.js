// ========== Pole Utility Functions ==========

// Rebuild poles array from selected pole sets
function rebuildPolesFromSelection() {
    poles = [];
    try { polesLayer.clearLayers(); } catch (e) { }
    const checked = Array.from(poleCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value);
    checked.forEach(key => {
        const arr = poleSetsData.get(key) || [];
        poles.push(...arr);
    });
    // draw poles on map
    poles.forEach(p => {
        const mk = L.circleMarker([p.lat, p.lng], {
            radius: 3,
            color: '#ff8c00',
            weight: 1,
            fillColor: '#ffa500',
            fillOpacity: 0.95
        });
        mk.bindTooltip(`Pole: ${p.code || p.name || p.id}`);
        mk.bindPopup(`<b>Pole</b><br>Code: ${p.code || p.id}<br>Type: ${p.type}<br>Coordinate: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
        polesLayer.addLayer(mk);
    });
    // rebuild adjacency when poles change
    try { buildPoleCodeAdjacency(); } catch (e) { console.warn('buildPoleCodeAdjacency failed', e); }
    try { buildPoleProximityAdj(); } catch (e) { console.warn('buildPoleProximityAdj failed', e); }
    // draw links between poles
    try { drawAllPoleLinks(); } catch (e) { console.warn('drawAllPoleLinks failed', e); }
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

function clearPoleLinks() {
    try { poleLinksLayer.clearLayers(); } catch (e) { }
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
