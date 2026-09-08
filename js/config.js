// ========== Configuration Constants ==========

// Global pole snap threshold (km). Adjust to change how far from a point we will consider poles.
// Default 1.0 km (1000 m). You can reduce to 0.5 for stricter snapping.
let POLE_SNAP_THRESHOLD_KM = 1.0;

// Style definitions for different pole types
const COT_STYLE = {
    cot: { color: '#ff6b35', radius: 4, label: 'Cột trung thế' },
    trudon: { color: '#4ecdc4', radius: 4, label: 'Trụ đơn' },
    default: { color: '#95a5a6', radius: 4, label: 'Khác' }
};

// Route label layer for displaying route names
let routeLabelsLayer = null;

// Pole adjacency graph (for routing via poles)
let poleAdjacency = new Map();
let poleCodeAdj = new Map();
let poleProximityAdj = new Map();
let poleAdjacencySource = 'none';
