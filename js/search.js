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

// Initialize search event listeners
function initializeSearch() {
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
}
