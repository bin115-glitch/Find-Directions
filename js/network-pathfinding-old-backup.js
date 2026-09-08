// ========== Network Pathfinding Functions ==========

// Build adjacency map (undirected) from selected routes' segments
function buildAdjacencyForSelectedRoutes() {
    const checked = Array.from(routeCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value);
    const adjacency = new Map(); // nodeId -> Map(neighborId -> routeId)
    const allowedRouteIds = new Set(checked.map(id => Number(id))); // Track allowed routes for Dijkstra (as numbers)

    function addEdge(a, b, routeId) {
        if (!adjacency.has(a)) adjacency.set(a, new Map());
        if (!adjacency.has(b)) adjacency.set(b, new Map());
        adjacency.get(a).set(b, routeId);
        adjacency.get(b).set(a, routeId);
    }

    // Build adjacency from segments with RAW device IDs (preserve topology)
    console.log(`🔧 Building adjacency (preserving topology with ports)...`);
    for (const rid of checked) {
        const segs = segsByRoute.get(rid) || [];
        segs.forEach(s => {
            // ✅ Use RAW IDs to preserve actual network topology
            const a = s.startdeviceid;
            const b = s.enddeviceid;
            const routeId = Number(s.routecableid || rid);

            if (a != null && b != null) {
                addEdge(a, b, routeId);
            }
        });
    }

    console.log(`✅ Built adjacency with ${adjacency.size} nodes (ports preserved)`);
    console.log(`📊 Allowed route IDs:`, Array.from(allowedRouteIds));

    // Auto-connect POPs by finding nearest segment and creating virtual segments
    const nodesInGraph = new Set(adjacency.keys());
    const allNodesFromRoutes = [];
    const allSegmentsFromRoutes = [];

    // Collect all nodes and segments from selected routes
    for (const rid of checked) {
        const routeNodes = nodesByRoute.get(rid) || [];
        const routeSegs = segsByRoute.get(rid) || [];
        allNodesFromRoutes.push(...routeNodes);
        allSegmentsFromRoutes.push(...routeSegs);
    }

    // Find all segments' node IDs to identify which nodes have real segments
    const nodesWithRealSegments = new Set();
    allSegmentsFromRoutes.forEach(seg => {
        if (seg.startdeviceid != null) nodesWithRealSegments.add(seg.startdeviceid);
        if (seg.enddeviceid != null) nodesWithRealSegments.add(seg.enddeviceid);
    });

    // Find isolated POPs: type=1 nodes that have NO real segments
    const isolatedNodes = allNodesFromRoutes.filter(node => {
        if (!node || node.id == null) return false;
        return node.type === 1 && !nodesWithRealSegments.has(node.id);
    });

    console.log(`🔍 Found ${isolatedNodes.length} isolated nodes (likely POPs)`);

    if (isolatedNodes.length > 0) {
        console.log(`📋 Isolated nodes:`, isolatedNodes.map(n => n.name || n.id));
    }

    // Helper: Calculate distance from point to line segment
    function distanceToLineSegment(point, lineStart, lineEnd) {
        const [px, py] = point;
        const [x1, y1] = lineStart;
        const [x2, y2] = lineEnd;

        const A = px - x1;
        const B = py - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;

        if (lenSq !== 0) param = dot / lenSq;

        let xx, yy;

        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }

        const dx = px - xx;
        const dy = py - yy;
        return Math.sqrt(dx * dx + dy * dy) * 111.32; // Convert to km
    }

    // Helper: Find nearest segment to a POP
    function findNearbySegmentsToPOP(popNode, maxDistanceKm = 2.0) {
        const popCoords = getNodeCoordinatesSimple(popNode);
        if (!popCoords) return [];

        const nearbySegments = [];

        allSegmentsFromRoutes.forEach(seg => {
            const coords = parseLatLngString(seg.latlng);
            if (!coords || coords.length < 2) return;

            // Calculate minimum distance to any segment of the polyline
            let minDist = Infinity;
            for (let i = 0; i < coords.length - 1; i++) {
                const dist = distanceToLineSegment(popCoords, coords[i], coords[i + 1]);
                if (dist < minDist) {
                    minDist = dist;
                }
            }

            // Include segment if within radius
            if (minDist <= maxDistanceKm) {
                nearbySegments.push({ segment: seg, distance: minDist });
            }
        });

        // Sort by distance (closest first)
        nearbySegments.sort((a, b) => a.distance - b.distance);

        return nearbySegments;
    }

    let totalConnections = 0;
    let virtualNodeIdCounter = 900000000; // Start virtual node IDs from a high number to avoid conflicts
    const virtualNodeCoords = new Map(); // Store virtual node coordinates: nodeId -> [lat, lng]
    const virtualNodeSegments = new Map(); // Store which segment each virtual node belongs to: nodeId -> {segmentId, coords, closestPoint}

    // Helper: Find closest point on a polyline
    function findClosestPointOnPolyline(point, polylineCoords) {
        let minDist = Infinity;
        let closestPoint = null;
        let segmentIndex = -1;

        for (let i = 0; i < polylineCoords.length - 1; i++) {
            const [x1, y1] = polylineCoords[i];
            const [x2, y2] = polylineCoords[i + 1];
            const [px, py] = point;

            const A = px - x1;
            const B = py - y1;
            const C = x2 - x1;
            const D = y2 - y1;

            const dot = A * C + B * D;
            const lenSq = C * C + D * D;
            let param = -1;

            if (lenSq !== 0) param = dot / lenSq;

            let xx, yy;

            if (param < 0) {
                xx = x1;
                yy = y1;
            } else if (param > 1) {
                xx = x2;
                yy = y2;
            } else {
                xx = x1 + param * C;
                yy = y1 + param * D;
            }

            const dx = px - xx;
            const dy = py - yy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < minDist) {
                minDist = dist;
                closestPoint = [xx, yy];
                segmentIndex = i;
            }
        }

        return { point: closestPoint, segmentIndex };
    }

    // Create virtual segments for each POP
    isolatedNodes.forEach(popNode => {
        const nearbySegments = findNearbySegmentsToPOP(popNode, 2.0); // 2km radius

        if (nearbySegments.length === 0) {
            console.warn(`  ⚠️ No segments found within 2km for POP ${popNode.name || popNode.id}`);
            return;
        }

        console.log(`  🔗 Found ${nearbySegments.length} nearby segments for POP ${popNode.name || popNode.id}`);

        const popCoords = getNodeCoordinatesSimple(popNode);
        if (!popCoords) return;

        // For each nearby segment, create a virtual node on the segment
        nearbySegments.forEach(({ segment, distance }) => {
            const segmentCoords = parseLatLngString(segment.latlng);
            if (!segmentCoords || segmentCoords.length < 2) return;

            // Find the closest point on this segment's polyline
            const { point: closestPoint, segmentIndex } = findClosestPointOnPolyline(popCoords, segmentCoords);
            if (!closestPoint) return;

            // Create a unique virtual node ID for this connection point
            const virtualNodeId = virtualNodeIdCounter++;

            // Store virtual node coordinates
            virtualNodeCoords.set(virtualNodeId, closestPoint);
            virtualNodeSegments.set(virtualNodeId, {
                segmentId: `${segment.startdeviceid}-${segment.enddeviceid}`,
                fullCoords: segmentCoords,
                closestPoint: closestPoint,
                segmentIndex: segmentIndex,
                startNodeId: segment.startdeviceid,
                endNodeId: segment.enddeviceid
            });

            // Connect: POP -> Virtual Node -> BOTH segment endpoints
            // ✅ CHẺ SEGMENT: Virtual node phải nối về CẢ HAI ĐẦU để POP đi xuyên qua
            // Topology: A ---- virtual ---- B, với POP nối vào virtual
            // ✅ Virtual edges inherit route ID from parent segment
            const segmentRouteId = segment.routecableid || segment.routeid;

            addEdge(popNode.id, virtualNodeId, segmentRouteId);
            totalConnections++;

            // Nối virtual node về CẢ HAI endpoint của segment
            if (segment.startdeviceid != null) {
                addEdge(virtualNodeId, segment.startdeviceid, segmentRouteId);
                totalConnections++;
            }
            if (segment.enddeviceid != null) {
                addEdge(virtualNodeId, segment.enddeviceid, segmentRouteId);
                totalConnections++;
            }

            console.log(`    ✓ Created virtual node ${virtualNodeId} on segment ${segment.startdeviceid}-${segment.enddeviceid} (${distance.toFixed(3)} km)`);
        });
    });

    // Store virtual node data globally for geometry building
    window.virtualNodeCoords = virtualNodeCoords;
    window.virtualNodeSegments = virtualNodeSegments;

    console.log(`✅ Created ${totalConnections} virtual segment connections for POPs`);
    console.log(`📊 Total adjacency edges: ${Array.from(adjacency.values()).reduce((sum, map) => sum + map.size, 0) / 2}`);

    // Store adjacency and allowed routes globally
    window.currentAdjacency = adjacency;
    window.allowedRouteIds = allowedRouteIds;

    return adjacency;
}

function buildEdgeGeometryMap() {
    const checked = Array.from(routeCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value);
    const edgeMap = new Map(); // key a-b -> coords

    // Add real segments with RAW IDs (matching adjacency)
    console.log(`🔧 Building edge geometry (with port IDs)...`);
    for (const rid of checked) {
        const segs = segsByRoute.get(rid) || [];
        segs.forEach(s => {
            // ✅ Use raw IDs to match adjacency
            const a = s.startdeviceid;
            const b = s.enddeviceid;
            if (a == null || b == null) return;
            const coords = parseLatLngString(s.latlng);
            if (!coords || coords.length === 0) return;
            edgeMap.set(`${a}-${b}`, coords);
            edgeMap.set(`${b}-${a}`, coords.slice().reverse());
        });
    }

    // 🔧 Add geometry for virtual nodes (segment split)
    // This is CRITICAL: virtual nodes split segments topologically AND geometrically
    const vSegs = window.virtualNodeSegments || new Map();
    const vCoords = window.virtualNodeCoords || new Map();

    console.log(`🔧 Adding geometry for ${vSegs.size} virtual nodes`);

    for (const [vId, info] of vSegs.entries()) {
        const { fullCoords, segmentIndex, closestPoint, startNodeId, endNodeId } = info;
        const vPt = vCoords.get(vId);
        if (!vPt) continue;

        // Split original polyline into 2 parts at virtual node position
        const part1 = fullCoords.slice(0, segmentIndex + 1).concat([vPt]);
        const part2 = [vPt].concat(fullCoords.slice(segmentIndex + 1));

        // Add edges: startNode <-> virtualNode
        if (startNodeId != null) {
            edgeMap.set(`${startNodeId}-${vId}`, part1);
            edgeMap.set(`${vId}-${startNodeId}`, part1.slice().reverse());
            console.log(`  ✓ Added geometry ${startNodeId}-${vId} (${part1.length} points)`);
        }

        // Add edges: virtualNode <-> endNode
        if (endNodeId != null) {
            edgeMap.set(`${vId}-${endNodeId}`, part2);
            edgeMap.set(`${endNodeId}-${vId}`, part2.slice().reverse());
            console.log(`  ✓ Added geometry ${vId}-${endNodeId} (${part2.length} points)`);
        }
    }

    // Add virtual segments for POPs (POP -> virtualNode connections)
    const allNodesFromRoutes = [];
    for (const rid of checked) {
        const routeNodes = nodesByRoute.get(rid) || [];
        allNodesFromRoutes.push(...routeNodes);
    }

    // Find ONLY isolated POPs (nodes that have NO real segments)
    const adjacency = window.currentAdjacency;
    if (!adjacency) return edgeMap; // No adjacency built yet

    const nodesWithRealSegments = new Set();
    for (const rid of checked) {
        const segs = segsByRoute.get(rid) || [];
        segs.forEach(s => {
            nodesWithRealSegments.add(s.startdeviceid);
            nodesWithRealSegments.add(s.enddeviceid);
        });
    }

    // Only create virtual segments for nodes that:
    // 1. Are in adjacency (connected by auto-connect logic)
    // 2. Have NO real segments
    const isolatedPOPs = allNodesFromRoutes.filter(node => {
        if (!node || node.id == null) return false;
        return adjacency.has(node.id) && !nodesWithRealSegments.has(node.id);
    });

    console.log(`🔗 Creating POP->virtual segments for ${isolatedPOPs.length} isolated POPs`);

    isolatedPOPs.forEach(pop => {
        const popCoords = getNodeCoordinatesSimple(pop);
        if (!popCoords) return;

        const connectedNodes = adjacency.get(pop.id) || new Map();

        for (const nodeId of connectedNodes.keys()) {
            // Skip if edge already exists (real segment)
            if (edgeMap.has(`${pop.id}-${nodeId}`)) continue;

            // Check if it's a virtual node
            const vNodeCoords = vCoords.get(nodeId);
            if (vNodeCoords) {
                // POP -> virtual node: straight line
                const virtualSegment = [popCoords, vNodeCoords];
                edgeMap.set(`${pop.id}-${nodeId}`, virtualSegment);
                edgeMap.set(`${nodeId}-${pop.id}`, virtualSegment.slice().reverse());
                console.log(`  ✓ Added POP geometry ${pop.id}-${nodeId}`);
                continue;
            }

            // Fallback: regular node
            const otherNode = nodes.find(n => n.id === nodeId);
            if (!otherNode) continue;
            const otherCoords = getNodeCoordinatesSimple(otherNode);
            if (!otherCoords) continue;

            // Create virtual segment (straight line)
            const virtualSegment = [popCoords, otherCoords];
            edgeMap.set(`${pop.id}-${nodeId}`, virtualSegment);
            edgeMap.set(`${nodeId}-${pop.id}`, virtualSegment.slice().reverse());
        }
    });

    return edgeMap;
}

// Dijkstra shortest path (weights = polyline length km)
function computeShortestNetworkPath(startId, endId, adjacency, edgeMap) {
    if (!adjacency || !edgeMap) return false;
    const dist = new Map();
    const prev = new Map();
    const visited = new Set();
    const nodesIds = Array.from(adjacency.keys());
    nodesIds.forEach(id => dist.set(id, Infinity));
    if (!dist.has(startId)) return false;
    dist.set(startId, 0);

    console.log(`🔍 Dijkstra: Finding path from ${startId} to ${endId}`);
    console.log(`📊 Total nodes in adjacency: ${nodesIds.length}`);

    function extractMin() {
        let best = null, bestD = Infinity;
        for (const id of nodesIds) {
            if (visited.has(id)) continue;
            const d = dist.get(id);
            if (d < bestD) {
                bestD = d;
                best = id;
            }
        }
        return best;
    }

    let iterations = 0;
    while (true) {
        const u = extractMin();
        if (u == null) break;
        if (u === endId) break;
        visited.add(u);
        iterations++;

        const nexts = adjacency.get(u);
        if (!nexts) {
            console.warn(`⚠️ Node ${u} has no adjacency`);
            continue;
        }

        console.log(`🔄 Iteration ${iterations}: Processing node ${u}, neighbors: ${nexts.size}`);

        const allowedRouteIds = window.allowedRouteIds || new Set();

        for (const [v, edgeRouteId] of nexts) {
            // ✅ RÀNG BUỘC: Chỉ đi trên route đã chọn
            if (allowedRouteIds.size > 0 && !allowedRouteIds.has(edgeRouteId)) {
                continue; // Skip edges from other routes
            }

            const coords = edgeMap.get(`${u}-${v}`);
            let w = 0;


            if (!coords || coords.length < 2) {
                // Missing geometry - use Euclidean distance as fallback
                const virtualNodeCoords = window.virtualNodeCoords || new Map();

                // Try to find regular nodes, fallback to virtual nodes
                let nodeU = nodes.find(n => n.id === u);
                let nodeV = nodes.find(n => n.id === v);

                // If not found in regular nodes, check virtual nodes
                if (!nodeU && virtualNodeCoords.has(u)) {
                    const vCoords = virtualNodeCoords.get(u);
                    nodeU = { id: u, latlng: `${vCoords[0]},${vCoords[1]}` };
                }
                if (!nodeV && virtualNodeCoords.has(v)) {
                    const vCoords = virtualNodeCoords.get(v);
                    nodeV = { id: v, latlng: `${vCoords[0]},${vCoords[1]}` };
                }

                if (nodeU && nodeV && nodeU.latlng && nodeV.latlng) {
                    const coordU = getNodeCoordinatesSimple(nodeU);
                    const coordV = getNodeCoordinatesSimple(nodeV);

                    if (coordU && coordV) {
                        w = calculateDistance(coordU[0], coordU[1], coordV[0], coordV[1]);
                        console.warn(`⚠️ Dijkstra: Missing geometry for ${u}-${v}, using Euclidean distance: ${w.toFixed(3)} km`);
                    } else {
                        console.error(`❌ Cannot compute distance for ${u}-${v}: missing coordinates`);
                        continue;
                    }
                } else {
                    console.error(`❌ Cannot find nodes for ${u}-${v}`);
                    continue;
                }
            } else {
                // Has geometry - compute actual path length
                for (let i = 1; i < coords.length; i++) {
                    w += calculateDistance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
                }
            }

            const alt = dist.get(u) + w;
            if (alt < dist.get(v)) {
                dist.set(v, alt);
                prev.set(v, u);
                console.log(`  ✓ Updated ${v}: dist=${alt.toFixed(3)} km, prev=${u}`);
            }
        }
    }

    if (!prev.has(endId) && startId !== endId) {
        console.error(`❌ No path found from ${startId} to ${endId}`);
        return false;
    }

    const path = [endId];
    let cur = endId;
    while (cur !== startId) {
        const p = prev.get(cur);
        if (p == null) break;
        path.push(p);
        cur = p;
    }
    path.reverse();

    console.log(`✅ Path found (${path.length} nodes):`, path.join(' -> '));

    let totalKm = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const coords = edgeMap.get(`${a}-${b}`);
        if (coords && coords.length) {
            for (let j = 1; j < coords.length; j++) {
                totalKm += calculateDistance(coords[j - 1][0], coords[j - 1][1], coords[j][0], coords[j][1]);
            }
        }
    }
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

    // Track missing edges for debugging
    const missingEdges = [];

    // draw each edge segment
    for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const coords = edgeMap.get(`${a}-${b}`);

        if (!coords || coords.length < 2) {
            // Missing geometry - draw straight line fallback
            missingEdges.push(`${a}-${b}`);

            // Find node coordinates for fallback
            const nodeA = nodes.find(n => n.id === a);
            const nodeB = nodes.find(n => n.id === b);

            if (nodeA && nodeB && nodeA.latlng && nodeB.latlng) {
                const coordA = getNodeCoordinatesSimple(nodeA);
                const coordB = getNodeCoordinatesSimple(nodeB);

                if (coordA && coordB) {
                    // Draw dashed line to indicate missing geometry
                    const pl = L.polyline([coordA, coordB], {
                        color,
                        weight,
                        opacity: opacity * 0.7,
                        dashArray: '10,10'
                    });
                    grp.addLayer(pl);
                    console.warn(`⚠️ Missing edge geometry for ${a}-${b}, drew straight line fallback`);
                }
            }
            continue;
        }

        const pl = L.polyline(coords, { color, weight, opacity });
        grp.addLayer(pl);
    }

    if (missingEdges.length > 0) {
        console.warn(`⚠️ Path has ${missingEdges.length} missing edge geometries:`, missingEdges);
    }

    return { km: totalKm, grp, missingEdges };
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
    let total = 0;
    const lens = [0];
    for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1];
        const b = coords[i];
        const d = calculateDistance(a[0], a[1], b[0], b[1]);
        total += d;
        lens.push(total);
    }
    const half = total / 2;
    for (let i = 1; i < lens.length; i++) {
        if (lens[i] >= half) {
            const a = coords[i - 1];
            const b = coords[i];
            const prev = lens[i - 1];
            const segLen = lens[i] - prev;
            const t = segLen === 0 ? 0 : (half - prev) / segLen;
            const lat = a[0] + (b[0] - a[0]) * t;
            const lng = a[1] + (b[1] - a[1]) * t;
            return [lat, lng];
        }
    }
    // fallback last
    const last = coords[coords.length - 1];
    return [last[0], last[1]];
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

async function findAndDrawNetworkPaths() {
    if (!startNearbyCandidates || !endNearbyCandidates || startNearbyCandidates.length === 0 || endNearbyCandidates.length === 0) return;
    const adjacency = buildAdjacencyForSelectedRoutes();
    const edgeMap = buildEdgeGeometryMap();

    // Helper: find nearest node id that exists in adjacency (by geographic distance)
    function nearestAdjNodeId(lat, lng, adjacencyMap) {
        let best = null;
        let bestD = Infinity;
        for (const id of adjacencyMap.keys()) {
            // find node object with this id
            const nodeObj = nodes.find(n => n.id === id);
            if (!nodeObj || !nodeObj.latlng) continue;
            const c = getNodeCoordinatesSimple(nodeObj);
            if (!c) continue;
            const d = calculateDistance(lat, lng, c[0], c[1]);
            if (d < bestD) {
                bestD = d;
                best = id;
            }
        }
        return best;
    }

    try { walkingRoutesLayer.clearLayers(); } catch (eClear) { walkingRoutesLayer = L.layerGroup().addTo(map); }

    // Build candidate lists (top N nearest) for start and end, prioritizing nearby candidates then adjacency nodes
    const MAX_CANDIDATES = 5;
    const sCoords = startPointCoords || (startNearbyCandidates[0] ? [startNearbyCandidates[0].lat, startNearbyCandidates[0].lng] : null);
    const eCoords = endPointCoords || (endNearbyCandidates[0] ? [endNearbyCandidates[0].lat, endNearbyCandidates[0].lng] : null);

    function uniqueById(arr) {
        const seen = new Set();
        const out = [];
        arr.forEach(a => {
            if (!a) return;
            const id = a.id;
            if (id == null) return;
            if (!seen.has(id)) {
                seen.add(id);
                out.push(a);
            }
        });
        return out;
    }

    // gather top nearest from nearbyCandidate lists
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
            if (ds <= 0.5) adjStarts.push({ id: nodeObj.id, name: nodeObj.name || nodeObj.code || '', lat: c[0], lng: c[1], dist: ds, nodeType: nodeObj.type });
        }
        if (eCoords) {
            const de = calculateDistance(eCoords[0], eCoords[1], c[0], c[1]);
            if (de <= 0.5) adjEnds.push({ id: nodeObj.id, name: nodeObj.name || nodeObj.code || '', lat: c[0], lng: c[1], dist: de, nodeType: nodeObj.type });
        }
    }
    adjStarts.sort((a, b) => a.dist - b.dist);
    adjEnds.sort((a, b) => a.dist - b.dist);
    startCandidates = uniqueById(startCandidates.concat(adjStarts));
    endCandidates = uniqueById(endCandidates.concat(adjEnds));

    // If candidate pairs explode, trim to nearest 10 on each side
    const PAIR_LIMIT = 200;
    if ((startCandidates.length * endCandidates.length) > PAIR_LIMIT) {
        startCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
        endCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
        startCandidates = startCandidates.slice(0, 10);
        endCandidates = endCandidates.slice(0, 10);
    }

    if (!startCandidates.length || !endCandidates.length) {
        console.log('No start/end candidates after expansion');
        return;
    }

    // Evaluate all pairs and collect results
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
    if (!allResults.length) {
        console.log('No network path found among candidates');
        return;
    }

    // sort by network distance and pick top 10
    allResults.sort((a, b) => a.networkKm - b.networkKm);
    const topResults = allResults.slice(0, 10);
    const best = topResults[0];

    // draw the best network path
    const resBest = drawWeightedNetworkPathBetweenNodes(best.startNode.id, best.endNode.id, adjacency, edgeMap, { color: '#28a745', weight: 8, opacity: 0.95 });
    if (resBest && resBest.grp) {
        walkingRoutesLayer.addLayer(resBest.grp);
        // attach click handler
        try {
            resBest.grp.eachLayer(layer => {
                try {
                    layer.on && layer.on('click', () => {
                        try { renderTopResults(window.__lastTopResults || topResults); } catch (e) { }
                    });
                } catch (e) { }
            });
        } catch (e) { }

        // Draw walking legs
        try {
            let leg1 = null;
            let leg2 = null;
            if (startPointCoords && best && best.startNode) {
                try { leg1 = await routeViaPolesToNode(startPointCoords[0], startPointCoords[1], best.startNode.id); } catch (e) { }
                if (!leg1) {
                    try { leg1 = await routeViaPolesWalk(startPointCoords[0], startPointCoords[1], best.startNode.lat, best.startNode.lng, { computeOnly: false }); } catch (e) { }
                }
                if (!leg1) {
                    try { leg1 = await chooseBestWalkingLeg(startPointCoords[0], startPointCoords[1], best.startNode.lat, best.startNode.lng, { color: '#1e90ff' }); } catch (e) { }
                }
                if (!leg1 || !leg1.drawn) {
                    try {
                        const sx = startPointCoords[0], sy = startPointCoords[1];
                        const tx = (best.startNode.lat != null) ? best.startNode.lat : null;
                        const ty = (best.startNode.lng != null) ? best.startNode.lng : null;
                        if ((tx !== null) && (ty !== null)) {
                            const fallbackLine = L.polyline([[sx, sy], [tx, ty]], { color: '#1e90ff', weight: 6, opacity: 0.9, dashArray: '2,6' });
                            walkingRoutesLayer.addLayer(fallbackLine);
                        }
                    } catch (errFb) { }
                }
            }
            if (endPointCoords && best && best.endNode) {
                try { leg2 = await routeViaPolesToNode(endPointCoords[0], endPointCoords[1], best.endNode.id); } catch (e) { }
                if (!leg2) {
                    try { leg2 = await routeViaPolesWalk(endPointCoords[0], endPointCoords[1], best.endNode.lat, best.endNode.lng, { computeOnly: false }); } catch (e) { }
                }
                if (!leg2) {
                    try { leg2 = await chooseBestWalkingLeg(endPointCoords[0], endPointCoords[1], best.endNode.lat, best.endNode.lng, { color: '#1e90ff', clipToEnd: true }); } catch (e) { }
                }
                if (!leg2 || !leg2.drawn) {
                    try {
                        const tx = endPointCoords[0], ty = endPointCoords[1];
                        const sx = (best.endNode.lat != null) ? best.endNode.lat : null;
                        const sy = (best.endNode.lng != null) ? best.endNode.lng : null;
                        if ((sx !== null) && (sy !== null)) {
                            const fallbackLine2 = L.polyline([[sx, sy], [tx, ty]], { color: '#1e90ff', weight: 6, opacity: 0.9, dashArray: '2,6' });
                            walkingRoutesLayer.addLayer(fallbackLine2);
                        }
                    } catch (errFb) { }
                }
            }

            // save results
            try {
                window.__lastTopResults = topResults;
                window.__lastEdgeMap = edgeMap;
                window.__lastAdjacency = adjacency;
                renderTopResults(topResults);
            } catch (e) { }

            // show popup
            const walkingKm1 = (typeof leg1 === 'object' && leg1 && Number.isFinite(leg1.km)) ? leg1.km : 0;
            const walkingKm2 = (typeof leg2 === 'object' && leg2 && Number.isFinite(leg2.km)) ? leg2.km : 0;
            const totalKm = walkingKm1 + (best.networkKm || 0) + walkingKm2;
            if (endPointMarker) endPointMarker.bindPopup(`<b>Best network path</b><br>Walking leg 1: ${walkingKm1.toFixed(3)} km<br>Network: ${(best.networkKm || 0).toFixed(3)} km<br>Walking leg 2: ${walkingKm2.toFixed(3)} km<br><b>Total: ${totalKm.toFixed(3)} km</b>`).openPopup();
        } catch (errLeg) {
            try {
                window.__lastTopResults = topResults;
                window.__lastEdgeMap = edgeMap;
                window.__lastAdjacency = adjacency;
                renderTopResults(topResults);
            } catch (e) { }
            if (endPointMarker) endPointMarker.bindPopup(`<b>Best network path</b><br>Distance: ${best.networkKm.toFixed(3)} km`).openPopup();
        }
    }

    // 💾 Auto-save logs after pathfinding completes
    if (window.logger && window.logger.saveNow) {
        try { window.logger.saveNow(); } catch (e) { }
    }
}

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
