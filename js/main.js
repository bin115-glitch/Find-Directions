// ========== Main Initialization and Event Handlers ==========

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Load routes and poles data
    loadRoutesAndPoles();

    // Initialize search functionality
    initializeSearch();

    // Setup sidebar collapse/expand
    setupSidebarControls();

    // Setup coordinate picking
    setupCoordinatePicking();

    // Setup pathfinding button
    setupPathfindingButton();
});

// Setup sidebar collapse/expand controls
function setupSidebarControls() {
    const sidebar = document.getElementById('sidebar');
    const collapseBtn = document.getElementById('collapseBtn');
    const sidebarHandle = document.getElementById('sidebarHandle');

    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            sidebar.classList.add('collapsed');
            sidebarHandle.style.display = 'block';
        });
    }

    if (sidebarHandle) {
        sidebarHandle.addEventListener('click', () => {
            sidebar.classList.remove('collapsed');
            sidebarHandle.style.display = 'none';
        });
    }
}

// Setup coordinate picking functionality
function setupCoordinatePicking() {
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
            try { if (routeLabelsLayer) routeLabelsLayer.clearLayers(); } catch (e) { }
            startPointCoords = null; endPointCoords = null;
            isCoordinateMode = false; coordinateModeType = 'start';
            if (coordBtn) { coordBtn.textContent = '📍 Lấy tọa độ'; coordBtn.style.background = '#28a745'; }
        });
    }

    // Map click to pick coordinate (supports start and end)
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
}

// Unified handler for picking start/end coordinates
function handleCoordinatePick(lat, lng, type) {
    const radiusKm = 0.5;
    const coordBtn = document.getElementById('getCoordinatesBtn');

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

// Setup pathfinding button
function setupPathfindingButton() {
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
}

// Note: findAndDrawNetworkPaths and other complex functions are too large
// They should remain in load_data_only.js or be split into additional modules
// For now, we keep the essential initialization code here
