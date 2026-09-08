// ========== Pathfinding and Routing Functions ==========

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

    // 🔍 DEBUG: Log detailed info if neighbors found
    if (startNeighbors.length === 0) {
        console.warn(`⚠️ routeViaPolesWalk: No start neighbors found within ${snapKm}km of (${startLat}, ${startLng})`);
        return null;
    }
    if (endNeighbors.length === 0) {
        console.warn(`⚠️ routeViaPolesWalk: No end neighbors found within ${snapKm}km of (${endLat}, ${endLng})`);
        return null;
    }

    console.log(`  ✓ Start neighbors: ${startNeighbors.slice(0, 3).map(n => `pole[${n.idx}] @ ${n.cost.toFixed(3)}km`).join(', ')}`);
    console.log(`  ✓ End neighbors: ${endNeighbors.slice(0, 3).map(n => `pole[${n.idx}] @ ${n.cost.toFixed(3)}km`).join(', ')}`);
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

    if (!bestEnd) {
        console.warn(`⚠️ routeViaPolesWalk: No path found between start and end pole neighbors (Dijkstra failed)`);
        console.warn(`  → Checked ${endNeighbors.length} end poles, none reachable from start poles`);
        return null;
    }

    const pathIdx = [];
    let cur = bestEnd.idx;
    while (cur !== -1) { pathIdx.push(cur); cur = prev[cur]; }
    pathIdx.reverse();
    console.log(`  ✓ Found pole path with ${pathIdx.length} poles, total distance: ${bestEnd.total.toFixed(3)}km`);
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

// Route via poles to a specific network node (draw straight pole-to-pole connectors)
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
        console.warn(`⚠️ routeViaPolesToNode: No code-based pole adjacency (source: ${window.poleAdjacencySource || 'none'})`);
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
    if (startIdx == null || endIdx == null) {
        console.warn(`⚠️ routeViaPolesToNode: No poles found (startIdx: ${startIdx}, endIdx: ${endIdx})`);
        return null;
    }
    if (bestSd > POLE_SNAP_THRESHOLD_KM || bestEd > POLE_SNAP_THRESHOLD_KM) {
        console.warn(`⚠️ routeViaPolesToNode: Poles too far (start: ${bestSd.toFixed(3)}km, end: ${bestEd.toFixed(3)}km, threshold: ${POLE_SNAP_THRESHOLD_KM}km)`);
        return null;
    }

    console.log(`  ✓ routeViaPolesToNode: Using poles (start pole[${startIdx}] @ ${bestSd.toFixed(3)}km, end pole[${endIdx}] @ ${bestEd.toFixed(3)}km)`);
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
    // sort by distance (POP preference handled elsewhere)
    out.sort((a, b) => a.dist - b.dist);
    return out;
}

// Helper function to find nearby candidates with fallback to all loaded nodes
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
