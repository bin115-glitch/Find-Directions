// ========== UI Handlers and Rendering Functions ==========

// Render top results into modal table
function renderTopResults(results) {
    const body = document.getElementById('topResultsModalBody');
    const modal = document.getElementById('topResultsModal');
    if (!body || !modal) return;
    if (!results || results.length === 0) {
        body.innerHTML = '<div>No candidates</div>';
        modal.style.display = 'none';
        return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;">';
    html += '<tr style="font-weight:bold;background:#f0f0f0;"><td style="width:30px">#</td><td>Điểm đầu</td><td>Tuyến</td><td>Điểm cuối</td><td style="width:120px;text-align:center">Số POPs trung gian</td><td style="width:90px;text-align:right">Km</td><td style="width:120px">Hành động</td></tr>';
    results.forEach((r, idx) => {
        const sname = (r.startNode && (r.startNode.name || r.startNode.id)) || '';
        const ename = (r.endNode && (r.endNode.name || r.endNode.id)) || '';
        const routes = getRouteNamesForPath(r.networkRes && r.networkRes.path) || [];
        let popCabCount = 0;
        try {
            // ✅ FIX: Path now contains NAMES, not IDs
            const pathNames = (r.networkRes && r.networkRes.path) ? r.networkRes.path : [];
            const nodesByName = window.nodesByName || new Map();

            for (let i = 0; i < pathNames.length; i++) {
                const nodeName = pathNames[i];
                const nodeObj = nodesByName.get(nodeName);
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

function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function alertTopResult(idx) {
    const results = window.__lastTopResults || [];
    const r = results[idx];
    if (!r) return alert('No result');

    // ✅ FIX: Path now contains NAMES directly, no mapping needed
    const pathNames = (r.networkRes && r.networkRes.path) ? r.networkRes.path : [];

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

    // ✅ FIX: Use NAMES for drawing, not IDs
    const resBest = drawWeightedNetworkPathBetweenNodes(r.startNode.name, r.endNode.name, adjacency, edgeMap, { color: '#28a745', weight: 8, opacity: 0.95 });
    if (resBest && resBest.grp) walkingRoutesLayer.addLayer(resBest.grp);

    // Draw walking/pole legs
    try {
        let leg1 = null, leg2 = null;
        if (startPointCoords && r && r.startNode) {
            try { leg1 = await routeViaPolesToNode(startPointCoords[0], startPointCoords[1], r.startNode.id); } catch (e) { }
            if (!leg1) {
                try { leg1 = await routeViaPolesWalk(startPointCoords[0], startPointCoords[1], r.startNode.lat, r.startNode.lng, { computeOnly: false }); } catch (e) { }
            }
            if (!leg1) {
                try { leg1 = await chooseBestWalkingLeg(startPointCoords[0], startPointCoords[1], r.startNode.lat, r.startNode.lng, { color: '#1e90ff' }); } catch (e) { }
            }
        }
        if (endPointCoords && r && r.endNode) {
            try { leg2 = await routeViaPolesToNode(endPointCoords[0], endPointCoords[1], r.endNode.id); } catch (e) { }
            if (!leg2) {
                try { leg2 = await routeViaPolesWalk(endPointCoords[0], endPointCoords[1], r.endNode.lat, r.endNode.lng, { computeOnly: false }); } catch (e) { }
            }
            if (!leg2) {
                try { leg2 = await chooseBestWalkingLeg(endPointCoords[0], endPointCoords[1], r.endNode.lat, r.endNode.lng, { color: '#1e90ff', clipToEnd: true }); } catch (e) { }
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
    const path = (r.networkRes && r.networkRes.path) || [];  // Array of NAMES now
    for (let i = 0; i < path.length - 1; i++) {
        const coords = (edgeMap.get(`${path[i]}-${path[i + 1]}`) || []);
        coords.forEach(c => bounds.push(c));
    }

    // clear previous route labels then add labels for each node on path
    try { routeLabelsLayer.clearLayers(); } catch (e) { }
    try {
        // ✅ FIX: Path contains NAMES, use nodesByName for lookup
        const nodesByName = window.nodesByName || new Map();
        const popCabNodes = [];

        path.forEach(nodeName => {
            const nodeObj = nodesByName.get(nodeName);
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

// Clear cot lines layer
function clearCotLinesLayer() {
    try { cotLinesLayer.clearLayers(); } catch (e) { }
}
