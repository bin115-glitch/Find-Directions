        function clearCotLinesLayer() {
            try { cotLinesLayer.clearLayers(); } catch (e) { }
        }
        async function loadAndDrawLinesFromUrl(url, options = {}) {
            try {
                const append = options && options.append === true;
                if (!append) {
                    clearCotLinesLayer();
                    cotTrungLineGeometries = [];
                }
                cotTrungLineAdjacencyDirty = true;
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
                            cotTrungLineGeometries.push({ coords: latlngs, name });
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
                                cotTrungLineGeometries.push({ coords: latlngs, name });
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
                                color: '#ff8c00',
                                weight: 1,
                                fillColor: '#ff8c00',
                                fillOpacity: 0.9
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
                                    color: '#ff8c00',
                                    weight: 1,
                                    fillColor: '#ff8c00',
                                    fillOpacity: 0.9
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
                                cotTrungLineGeometries.push({ coords, name: s.name || '' });
                                lineBounds.push(...coords);
                            }
                            drawn++;
                        });
                    }
                }

                if (lineBounds.length) fitMapToLatLngs(lineBounds);

                console.log(`✅ Successfully drew ${drawn} power lines from ${url.split('/').pop()}`);
                try { rebuildCotTrungLineAdjacency(); } catch (e) { console.warn('rebuildCotTrungLineAdjacency failed', e); }
                try { drawAllPoleLinks(); } catch (e) { console.warn('drawAllPoleLinks failed after line load', e); }

                if (drawn === 0 && !options.quiet) {
                    alert('Không tìm thấy dữ liệu đường dây hợp lệ trong file này.');
                } else if (drawn > 0 && !options.quiet) {
                    alert(`Vẽ xong ${drawn} đường dây`);
                }

            } catch (e) {
                alert('Lỗi đọc file hoặc vẽ đường dây: ' + (e && e.message));
                console.warn('loadAndDrawLinesFromUrl failed', url, e);
            }
        }
