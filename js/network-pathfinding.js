// ========== Network Pathfinding Functions ==========

// Build adjacency map (undirected) from selected routes' segments
// ✅ NAME-BASED ARCHITECTURE: Uses device names as primary keys instead of IDs
function buildAdjacencyForSelectedRoutes() {
    const checked = Array.from(routeCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value);
    const adjacency = new Map(); // name -> Map<neighborName, routeId> - ✅ FIX 4: Map auto-deduplicates
    const allowedRouteIds = new Set(checked.map(id => Number(id)));

    console.log(`🔧 Building NAME-BASED adjacency map...`);

    // Build name-to-node lookup index from ALL selected nodes
    // This allows cross-ring pathfinding using unique device names
    const nodesByName = new Map(); // name -> {id, type, coords, ring}
    const allNodesFromRoutes = [];

    for (const rid of checked) {
        const routeNodes = nodesByRoute.get(rid) || [];
        allNodesFromRoutes.push(...routeNodes);
    }

    // Index all nodes by name
    allNodesFromRoutes.forEach(node => {
        if (node && node.name) {
            nodesByName.set(node.name, node);
        }
    });

    console.log(`📋 Indexed ${nodesByName.size} unique nodes by name`);

    // Helper: Add bidirectional edge using device names
    // ✅ FIX 4: Use Map for automatic deduplication of edges
    // Map<neighborName, routeId> prevents duplicate neighbors → reduces branching factor
    function addEdge(nameA, nameB, routeId) {
        if (!nameA || !nameB) {
            console.warn(`⚠️ Cannot add edge with null names: ${nameA} <-> ${nameB}`);
            return;
        }

        if (!adjacency.has(nameA)) adjacency.set(nameA, new Map());
        if (!adjacency.has(nameB)) adjacency.set(nameB, new Map());

        adjacency.get(nameA).set(nameB, routeId);
        adjacency.get(nameB).set(nameA, routeId);
    }

    // Build adjacency from segments using device names
    for (const rid of checked) {
        const segs = segsByRoute.get(rid) || [];
        segs.forEach(s => {
            const nameA = s.startdevicename;
            const nameB = s.enddevicename;
            const routeId = Number(s.routecableid || rid);

            // Skip segments without valid names
            if (!nameA || !nameB) {
                console.warn(`⚠️ Skipping segment with missing names: start=${nameA}, end=${nameB}`);
                return;
            }

            // Skip self-loops (same device connected to itself)
            if (nameA === nameB) {
                console.warn(`⚠️ Skipping self-loop: ${nameA} -> ${nameB}`);
                return;
            }

            // ✅ NO VALIDATION NEEDED: Names are unique across rings!
            // Both nodes can be from different rings - that's the whole point!
            addEdge(nameA, nameB, routeId);
        });
    }

    // Store nodesByName globally for use in Dijkstra and path drawing
    window.nodesByName = nodesByName;

    console.log(`✅ Built adjacency with ${adjacency.size} unique device names`);
    console.log(`📊 Allowed route IDs:`, Array.from(allowedRouteIds));

    // Auto-connect POPs by finding nearest segment and creating virtual segments
    // ✅ NAME-BASED: Virtual nodes get unique names like "VIRTUAL_NANP040_0"

    // Collect all segments from selected routes
    const allSegmentsFromRoutes = [];
    for (const rid of checked) {
        const routeSegs = segsByRoute.get(rid) || [];
        allSegmentsFromRoutes.push(...routeSegs);
    }

    // Find isolated POPs: type=1 nodes that are NOT in the adjacency graph yet
    const nodesInGraph = new Set(adjacency.keys());
    const isolatedNodes = allNodesFromRoutes.filter(node => {
        if (!node || !node.name) return false;
        return node.type === 1 && !nodesInGraph.has(node.name);
    });

    console.log(`🔍 Found ${isolatedNodes.length} isolated POPs`);

    if (isolatedNodes.length > 0) {
        console.log(`📋 Isolated POPs:`, isolatedNodes.map(n => n.name));
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
    let virtualNodeCounter = 0;
    const virtualNodeCoords = new Map(); // Store virtual node coordinates: name -> [lat, lng]
    const virtualNodeSegments = new Map(); // Store segment info: name -> {segmentId, coords, closestPoint}

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

    // Create virtual segments for each isolated POP
    // ✅ FIX 1: Only create ONE virtual node per POP (nearest segment)
    // ✅ FIX 2: Reduce radius from 2.0km to 0.5km
    isolatedNodes.forEach(popNode => {
        const nearbySegments = findNearbySegmentsToPOP(popNode, 0.5); // Down from 2.0km

        if (nearbySegments.length === 0) {
            console.warn(`  ⚠️ No segments found within 0.5km for POP ${popNode.name}`);
            return;
        }

        // ✅ FIX 1: Only take the NEAREST segment (already sorted by distance)
        const nearest = nearbySegments[0];
        const segment = nearest.segment;
        const distance = nearest.distance;

        console.log(`  🔗 Connecting POP ${popNode.name} to nearest segment (${distance.toFixed(3)} km)`);

        const popCoords = getNodeCoordinatesSimple(popNode);
        if (!popCoords) return;

        const segmentCoords = parseLatLngString(segment.latlng);
        if (!segmentCoords || segmentCoords.length < 2) return;

        // Find the closest point on this segment's polyline
        const { point: closestPoint, segmentIndex } = findClosestPointOnPolyline(popCoords, segmentCoords);
        if (!closestPoint) return;

        // Create a unique virtual node NAME (not ID!)
        const virtualNodeName = `VIRTUAL_${popNode.name}_${virtualNodeCounter++}`;

        // Store virtual node coordinates and metadata
        virtualNodeCoords.set(virtualNodeName, closestPoint);
        virtualNodeSegments.set(virtualNodeName, {
            segmentId: `${segment.startdevicename}-${segment.enddevicename}`,
            fullCoords: segmentCoords,
            closestPoint: closestPoint,
            segmentIndex: segmentIndex,
            startNodeName: segment.startdevicename,
            endNodeName: segment.enddevicename
        });

        // Connect: POP -> Virtual Node -> BOTH segment endpoints
        const segmentRouteId = segment.routecableid || segment.routeid;

        // POP to virtual node
        addEdge(popNode.name, virtualNodeName, segmentRouteId);
        totalConnections++;

        // Virtual node to segment endpoints (using NAMES!)
        if (segment.startdevicename) {
            addEdge(virtualNodeName, segment.startdevicename, segmentRouteId);
            totalConnections++;
        }
        if (segment.enddevicename) {
            addEdge(virtualNodeName, segment.enddevicename, segmentRouteId);
            totalConnections++;
        }

        console.log(`    ✅ Created virtual connection: ${popNode.name} -> ${virtualNodeName} -> [${segment.startdevicename}, ${segment.enddevicename}]`);
    });

    console.log(`🎯 Created ${totalConnections} virtual connections for ${isolatedNodes.length} isolated POPs`);

    // Store virtual node data globally
    window.virtualNodeCoords = virtualNodeCoords;
    window.virtualNodeSegments = virtualNodeSegments;

    return { adjacency, allowedRouteIds };
}


function buildEdgeGeometryMap() {
    const checked = Array.from(routeCheckboxes.querySelectorAll('input')).filter(i => i.checked).map(i => i.value);
    const edgeMap = new Map(); // key "nameA-nameB" -> coords

    console.log(`🔧 Building edge geometry map using device NAMES...`);

    // Add real segments using device names as keys
    for (const rid of checked) {
        const segs = segsByRoute.get(rid) || [];
        segs.forEach(s => {
            const nameA = s.startdevicename;
            const nameB = s.enddevicename;

            if (!nameA || !nameB) return;

            const coords = parseLatLngString(s.latlng);
            if (!coords || coords.length === 0) return;

            // Use NAMES as edge keys
            edgeMap.set(`${nameA}-${nameB}`, coords);
            edgeMap.set(`${nameB}-${nameA}`, coords.slice().reverse());
        });
    }

    // Add geometry for virtual nodes (segment split)
    const vSegs = window.virtualNodeSegments || new Map();
    const vCoords = window.virtualNodeCoords || new Map();

    console.log(`🔧 Adding geometry for ${vSegs.size} virtual node segments`);

    for (const [vName, info] of vSegs.entries()) {
        const { fullCoords, segmentIndex, closestPoint, startNodeName, endNodeName } = info;
        const vPt = vCoords.get(vName);
        if (!vPt) continue;

        // Split original polyline into 2 parts at virtual node position
        const part1 = fullCoords.slice(0, segmentIndex + 1).concat([vPt]);
        const part2 = [vPt].concat(fullCoords.slice(segmentIndex + 1));

        // Add edges: startNode <-> virtualNode
        if (startNodeName) {
            edgeMap.set(`${startNodeName}-${vName}`, part1);
            edgeMap.set(`${vName}-${startNodeName}`, part1.slice().reverse());
            console.log(`  ✓ Added geometry ${startNodeName}-${vName} (${part1.length} points)`);
        }

        // Add edges: virtualNode <-> endNode
        if (endNodeName) {
            edgeMap.set(`${vName}-${endNodeName}`, part2);
            edgeMap.set(`${endNodeName}-${vName}`, part2.slice().reverse());
            console.log(`  ✓ Added geometry ${vName}-${endNodeName} (${part2.length} points)`);
        }
    }

    // Add POP-to-virtual-node geometry (straight lines)
    const nodesByName = window.nodesByName || new Map();

    // Find isolated POPs (POPs with virtual connections)
    const adjacency = window.currentAdjacency;
    if (!adjacency) return edgeMap;

    for (const [nodeName, neighbors] of adjacency.entries()) {
        // Check if this is a POP
        const node = nodesByName.get(nodeName);
        if (!node || node.type !== 1) continue;

        const popCoords = getNodeCoordinatesSimple(node);
        if (!popCoords) continue;

        // Check each neighbor
        neighbors.forEach(edge => {
            const neighborName = edge.neighborName;

            // Skip if edge already exists (real segment)
            if (edgeMap.has(`${nodeName}-${neighborName}`)) return;

            // Check if neighbor is a virtual node
            const vNodeCoords = vCoords.get(neighborName);
            if (vNodeCoords) {
                // POP -> virtual node: straight line
                const virtualSegment = [popCoords, vNodeCoords];
                edgeMap.set(`${nodeName}-${neighborName}`, virtualSegment);
                edgeMap.set(`${neighborName}-${nodeName}`, virtualSegment.slice().reverse());
                console.log(`  ✓ Added POP geometry ${nodeName}-${neighborName}`);
            }
        });
    }

    console.log(`✅ Built edge geometry map with ${edgeMap.size} edges`);
    return edgeMap;
}

// A* shortest path algorithm (weights = polyline length km)
// ✅ NAME-BASED: Uses device names instead of IDs
// ⚡ FASTER: Uses heuristic (straight-line distance) to guide search toward goal
function computeShortestNetworkPath(startName, endName, adjacency, edgeMap) {
    if (!adjacency || !edgeMap) return false;

    const nodesByName = window.nodesByName || new Map();
    const virtualNodeCoords = window.virtualNodeCoords || new Map();

    // Get goal coordinates for heuristic
    const goalNode = nodesByName.get(endName);
    const goalVirtualCoords = virtualNodeCoords.get(endName);

    let goalCoords;
    if (goalNode && goalNode.latlng) {
        goalCoords = getNodeCoordinatesSimple(goalNode);
    } else if (goalVirtualCoords) {
        goalCoords = goalVirtualCoords; // Virtual nodes have coords directly
    }

    if (!goalCoords) {
        console.error(`❌ End node "${endName}" not found or has no coordinates`);
        return false;
    }

    // Heuristic function: straight-line distance to goal
    // ✅ CRITICAL: Also works for virtual nodes by checking virtualNodeCoords
    function heuristic(nodeName) {
        const node = nodesByName.get(nodeName);
        if (node && node.latlng) {
            const coords = getNodeCoordinatesSimple(node);
            if (coords) {
                return calculateDistance(coords[0], coords[1], goalCoords[0], goalCoords[1]);
            }
        }

        // Check if it's a virtual node
        const vCoords = virtualNodeCoords.get(nodeName);
        if (vCoords) {
            return calculateDistance(vCoords[0], vCoords[1], goalCoords[0], goalCoords[1]);
        }

        return 0; // Fallback (shouldn't happen)
    }

    // A* uses two scores:
    // gScore = actual distance from start
    // fScore = gScore + heuristic (estimated total distance)
    const gScore = new Map(); // name -> actual distance from start
    const fScore = new Map(); // name -> estimated total distance (g + h)
    const prev = new Map();   // name -> previousName
    const openSet = new Set(); // nodes to be evaluated
    const closedSet = new Set(); // nodes already evaluated

    const nodeNames = Array.from(adjacency.keys());
    nodeNames.forEach(name => {
        gScore.set(name, Infinity);
        fScore.set(name, Infinity);
    });

    if (!gScore.has(startName)) {
        console.error(`❌ Start node "${startName}" not in adjacency`);
        return false;
    }

    gScore.set(startName, 0);
    fScore.set(startName, heuristic(startName));
    openSet.add(startName);

    console.log(`🔍 A*: Finding path from "${startName}" to "${endName}"`);
    console.log(`📊 Total nodes in adjacency: ${nodeNames.length}`);

    // Extract node with lowest fScore from openSet
    function extractMin() {
        let best = null;
        let bestF = Infinity;
        for (const name of openSet) {
            const f = fScore.get(name);
            if (f < bestF) {
                bestF = f;
                best = name;
            }
        }
        return best;
    }

    const allowedRouteIds = window.allowedRouteIds || new Set();
    let iterations = 0;
    const MAX_ITER = 20000; // ✅ FIX 3: Hard limit to prevent excessive computation

    while (openSet.size > 0) {
        // ✅ FIX 3: Abort if too many iterations
        if (iterations > MAX_ITER) {
            console.warn(`⚠️ A* aborted after ${MAX_ITER} iterations - path too complex or graph has issues`);
            return false;
        }

        const current = extractMin();
        if (!current) break;

        // Goal reached!
        if (current === endName) {
            console.log(`✅ A* reached goal in ${iterations} iterations`);
            break;
        }

        openSet.delete(current);
        closedSet.add(current);
        iterations++;

        const nexts = adjacency.get(current);
        if (!nexts || !nexts.size) {
            console.warn(`⚠️ Node "${current}" has no adjacency`);
            continue;
        }

        if (iterations % 100 === 0) {
            console.log(`🔄 A* Iteration ${iterations}: Current="${current}", openSet=${openSet.size}, fScore=${fScore.get(current).toFixed(3)} km`);
        }

        // Check all neighbors
        for (const [neighbor, edgeRouteId] of nexts) {

            // Skip already evaluated nodes
            if (closedSet.has(neighbor)) continue;

            // Route filtering
            if (allowedRouteIds.size > 0 && !allowedRouteIds.has(edgeRouteId)) {
                continue;
            }

            const coords = edgeMap.get(`${current}-${neighbor}`);

            // No geometry = no edge
            if (!coords || coords.length < 2) {
                console.warn(`⚠️ A*: Skipping edge "${current}"-"${neighbor}" - no geometry`);
                continue;
            }

            // Compute actual edge length from geometry
            let edgeLength = 0;
            for (let i = 1; i < coords.length; i++) {
                edgeLength += calculateDistance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
            }

            // Tentative gScore for neighbor
            const tentativeGScore = gScore.get(current) + edgeLength;

            // Found a better path to neighbor?
            if (tentativeGScore < gScore.get(neighbor)) {
                prev.set(neighbor, current);
                gScore.set(neighbor, tentativeGScore);
                fScore.set(neighbor, tentativeGScore + heuristic(neighbor));

                if (!openSet.has(neighbor)) {
                    openSet.add(neighbor);
                }

                if (iterations % 50 === 0) {
                    console.log(`  ✓ Updated "${neighbor}": g=${tentativeGScore.toFixed(3)} km, h=${heuristic(neighbor).toFixed(3)} km, f=${fScore.get(neighbor).toFixed(3)} km`);
                }
            }
        }
    }

    if (!prev.has(endName) && startName !== endName) {
        console.error(`❌ No path found from "${startName}" to "${endName}"`);
        return false;
    }

    // Reconstruct path (array of names)
    const path = [];
    let cur = endName;
    while (cur != null) {
        path.push(cur);
        if (cur === startName) break;
        cur = prev.get(cur);
    }
    path.reverse();

    const finalDistance = gScore.get(endName);
    console.log(`✅ A* found path (${path.length} nodes, ${finalDistance.toFixed(3)} km):`, path.join(' -> '));
    console.log(`📊 A* explored ${closedSet.size} nodes (vs ${nodeNames.length} total)`);

    return { km: finalDistance, path };
}

function drawWeightedNetworkPathBetweenNodes(startName, endName, adjacency, edgeMap, options = {}) {
    if (!adjacency || !edgeMap) return false;
    const color = options.color || '#007f0e';
    const weight = options.weight || 6;
    const opacity = (typeof options.opacity === 'number') ? options.opacity : 0.95;
    const res = computeShortestNetworkPath(startName, endName, adjacency, edgeMap);
    if (!res) return false;
    const grp = L.layerGroup();
    const path = res.path; // Array of device names
    const totalKm = res.km || 0;

    const nodesByName = window.nodesByName || new Map();

    // Track missing edges for debugging
    const missingEdges = [];

    // draw each edge segment
    for (let i = 0; i < path.length - 1; i++) {
        const nameA = path[i];
        const nameB = path[i + 1];

        const coords = edgeMap.get(`${nameA}-${nameB}`);

        if (!coords || coords.length < 2) {
            // Try to draw fallback straight line
            const nodeA = nodesByName.get(nameA);
            const nodeB = nodesByName.get(nameB);

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
                    console.warn(`⚠️ Missing edge geometry for "${nameA}"-"${nameB}", drew straight line fallback`);
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
    const { adjacency, allowedRouteIds } = buildAdjacencyForSelectedRoutes();
    window.currentAdjacency = adjacency;
    window.allowedRouteIds = allowedRouteIds;
    const edgeMap = buildEdgeGeometryMap();

    try { walkingRoutesLayer.clearLayers(); } catch (eClear) { walkingRoutesLayer = L.layerGroup().addTo(map); }

    // Build candidate lists (top N nearest) for start and end, prioritizing nearby candidates then adjacency nodes
    const MAX_CANDIDATES = 5;
    const sCoords = startPointCoords || (startNearbyCandidates[0] ? [startNearbyCandidates[0].lat, startNearbyCandidates[0].lng] : null);
    const eCoords = endPointCoords || (endNearbyCandidates[0] ? [endNearbyCandidates[0].lat, endNearbyCandidates[0].lng] : null);

    function uniqueByName(arr) {
        const seen = new Set();
        const out = [];
        arr.forEach(a => {
            if (!a) return;
            const name = a.name;
            if (!name) return;
            if (!seen.has(name)) {
                seen.add(name);
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
    const nodesByName = window.nodesByName || new Map();

    for (const [nodeName, neighbors] of adjacency.entries()) {
        // Check if this is a real node or virtual node
        const nodeObj = nodesByName.get(nodeName);

        let c;
        if (nodeObj && nodeObj.latlng) {
            c = getNodeCoordinatesSimple(nodeObj);
        } else {
            // Virtual node - get coords from virtualNodeCoords
            const virtualNodeCoords = window.virtualNodeCoords || new Map();
            c = virtualNodeCoords.get(nodeName);
        }

        if (!c) continue;

        if (sCoords) {
            const ds = calculateDistance(sCoords[0], sCoords[1], c[0], c[1]);
            if (ds <= 0.5) adjStarts.push({ name: nodeName, lat: c[0], lng: c[1], dist: ds, nodeType: nodeObj?.type || 0 });
        }
        if (eCoords) {
            const de = calculateDistance(eCoords[0], eCoords[1], c[0], c[1]);
            if (de <= 0.5) adjEnds.push({ name: nodeName, lat: c[0], lng: c[1], dist: de, nodeType: nodeObj?.type || 0 });
        }
    }
    adjStarts.sort((a, b) => a.dist - b.dist);
    adjEnds.sort((a, b) => a.dist - b.dist);
    startCandidates = uniqueByName(startCandidates.concat(adjStarts));
    endCandidates = uniqueByName(endCandidates.concat(adjEnds));

    // If candidate pairs explode, trim to nearest 10 on each side
    const PAIR_LIMIT = 200;
    if ((startCandidates.length * endCandidates.length) > PAIR_LIMIT) {
        startCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
        endCandidates.sort((a, b) => (a.dist || 0) - (b.dist || 0));
        startCandidates = startCandidates.slice(0, 10);
        endCandidates = endCandidates.slice(0, 10);
    }


    // ✅ VALIDATION: Ensure user clicked near network nodes
    if (!startCandidates.length) {
        alert('❌ Không tìm thấy network node gần điểm bắt đầu!\\n\\nVui lòng click gần một node trên bản đồ (trong vòng 500m).');
        console.warn('⚠️ No start candidates found - user must click closer to a network node');
        return;
    }
    if (!endCandidates.length) {
        alert('❌ Không tìm thấy network node gần điểm kết thúc!\\n\\nVui lòng click gần một node trên bản đồ (trong vòng 500m).');
        console.warn('⚠️ No end candidates found - user must click closer to a network node');
        return;
    }

    // Evaluate all pairs and collect results
    const allResults = [];
    for (const sc of startCandidates) {
        for (const ec of endCandidates) {
            if (!sc || !ec || !sc.name || !ec.name) continue;
            const netRes = computeShortestNetworkPath(sc.name, ec.name, adjacency, edgeMap);
            if (!netRes) continue;
            const networkKm = netRes.km || Infinity;

            // ✅ CRITICAL FIX: Include walking distance from click points to nodes!
            // This ensures we choose the NEAREST network node, not just shortest network path
            const walkingStartKm = sc.dist || 0;  // Distance from click point to start node
            const walkingEndKm = ec.dist || 0;    // Distance from click point to end node

            // ✅ POLE PRIORITY: Apply weight reduction for poles to prefer them
            // Poles get 0.6x multiplier, making them MORE attractive than splice/manhole nodes
            const POLE_WEIGHT = 0.6;  // Boost priority for poles (lower = higher priority)
            const startWeight = (sc.type === 'pole') ? POLE_WEIGHT : 1.0;
            const endWeight = (ec.type === 'pole') ? POLE_WEIGHT : 1.0;

            const weightedWalkingStart = walkingStartKm * startWeight;
            const weightedWalkingEnd = walkingEndKm * endWeight;
            const totalKm = weightedWalkingStart + networkKm + weightedWalkingEnd;

            allResults.push({
                networkKm,
                walkingStartKm,
                walkingEndKm,
                weightedWalkingStart,
                weightedWalkingEnd,
                totalKm,
                startNode: sc,
                endNode: ec,
                networkRes: netRes
            });
        }
    }
    if (!allResults.length) {
        console.log('No network path found among candidates');
        return;
    }

    // ✅ FIX: Sort by TOTAL distance (walking + network), not just network distance!
    allResults.sort((a, b) => a.totalKm - b.totalKm);
    const topResults = allResults.slice(0, 10);
    const best = topResults[0];

    // draw the best network path
    const resBest = drawWeightedNetworkPathBetweenNodes(best.startNode.name, best.endNode.name, adjacency, edgeMap, { color: '#28a745', weight: 8, opacity: 0.95 });
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



        // ✅ Draw walking legs VIA POLES ONLY (no straight-line fallback)
        let leg1 = null;  // Declare outside try block for popup access
        let leg2 = null;
        try {

            // Walking leg 1: Start point → Network node (via poles)
            if (startPointCoords && best && best.startNode) {
                console.log(`🚶 Walking leg 1: From (${startPointCoords[0]}, ${startPointCoords[1]}) to node ${best.startNode.id}`);

                // Try 1: Route to specific node via poles
                try {
                    leg1 = await routeViaPolesToNode(startPointCoords[0], startPointCoords[1], best.startNode.id);
                    if (leg1) console.log('  ✓ routeViaPolesToNode: SUCCESS');
                } catch (e) {
                    console.warn('  ✗ routeViaPolesToNode: FAILED -', e.message);
                }

                // Try 2: Route to coordinates via poles
                if (!leg1) {
                    console.log('  → Trying routeViaPolesWalk...');
                    try {
                        leg1 = await routeViaPolesWalk(startPointCoords[0], startPointCoords[1], best.startNode.lat, best.startNode.lng, { computeOnly: false });
                        if (leg1) console.log('  ✓ routeViaPolesWalk: SUCCESS');
                        else console.warn('  ✗ routeViaPolesWalk: returned null');
                    } catch (e) {
                        console.warn('  ✗ routeViaPolesWalk: FAILED -', e.message);
                    }
                }

                // ❌ NO STRAIGHT-LINE FALLBACK - if poles not found, just skip
                if (!leg1 || !leg1.drawn) {
                    console.warn('  ⚠️ No pole route found for walking leg 1 - skipping (no fallback)');
                }
            }

            // Walking leg 2: Network node → End point (via poles)
            if (endPointCoords && best && best.endNode) {
                console.log(`🚶 Walking leg 2: From node ${best.endNode.id} to (${endPointCoords[0]}, ${endPointCoords[1]})`);

                // Try 1: Route to specific node via poles
                try {
                    leg2 = await routeViaPolesToNode(endPointCoords[0], endPointCoords[1], best.endNode.id);
                    if (leg2) console.log('  ✓ routeViaPolesToNode: SUCCESS');
                } catch (e) {
                    console.warn('  ✗ routeViaPolesToNode: FAILED -', e.message);
                }

                // Try 2: Route to coordinates via poles
                if (!leg2) {
                    console.log('  → Trying routeViaPolesWalk...');
                    try {
                        leg2 = await routeViaPolesWalk(endPointCoords[0], endPointCoords[1], best.endNode.lat, best.endNode.lng, { computeOnly: false, clipToEnd: true });
                        if (leg2) console.log('  ✓ routeViaPolesWalk: SUCCESS');
                        else console.warn('  ✗ routeViaPolesWalk: returned null');
                    } catch (e) {
                        console.warn('  ✗ routeViaPolesWalk: FAILED -', e.message);
                    }
                }

                // ❌ NO STRAIGHT-LINE FALLBACK - if poles not found, just skip
                if (!leg2 || !leg2.drawn) {
                    console.warn('  ⚠️ No pole route found for walking leg 2 - skipping (no fallback)');
                }
            }
        } catch (e) {
            console.error('Error drawing walking legs:', e);
        }

        // save results
        try {
            window.__lastTopResults = topResults;
            window.__lastEdgeMap = edgeMap;
            window.__lastAdjacency = adjacency;
            renderTopResults(topResults);
        } catch (e) { }

        // Show popup with walking legs (via poles) + network distance
        if (endPointMarker) {
            const walkingKm1 = (leg1 && leg1.km) ? leg1.km : 0;
            const walkingKm2 = (leg2 && leg2.km) ? leg2.km : 0;
            const networkKm = best.networkKm || 0;
            const totalKm = walkingKm1 + networkKm + walkingKm2;

            let popupContent = '<b>Network Path Found</b><br>';
            if (walkingKm1 > 0) popupContent += `Walking (via poles) 1: ${walkingKm1.toFixed(3)} km<br>`;
            popupContent += `Network: ${networkKm.toFixed(3)} km<br>`;
            if (walkingKm2 > 0) popupContent += `Walking (via poles) 2: ${walkingKm2.toFixed(3)} km<br>`;
            popupContent += `<b>Total: ${totalKm.toFixed(3)} km</b>`;

            endPointMarker.bindPopup(popupContent).openPopup();
        }
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
