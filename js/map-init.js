// ========== Map Initialization ==========

// Initialize Leaflet map
const map = L.map('map').setView([21.03, 105.81], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

// ========== DOM Elements ==========
const statusEl = document.getElementById('status');
const routeCheckboxes = document.getElementById('routeCheckboxes');
const poleCheckboxes = document.getElementById('poleCheckboxes');

// ========== Map Layers ==========
const dataLayer = L.layerGroup().addTo(map);
const polesLayer = L.layerGroup().addTo(map);
const poleLinksLayer = L.layerGroup().addTo(map);
const nearbyLayer = L.layerGroup().addTo(map);
const nearbyStartLayer = L.layerGroup().addTo(map);
const nearbyEndLayer = L.layerGroup().addTo(map);
const nearbyPoleStartLayer = L.layerGroup().addTo(map);
const walkingRoutesLayer = L.layerGroup().addTo(map);
const cotTrungLayer = L.layerGroup().addTo(map);
const cotLinesLayer = L.layerGroup().addTo(map);

// ========== Global State ==========

// Route and node data
const segsByRoute = new Map(); // routeId -> segments[]
const nodesByRoute = new Map(); // routeId -> nodes[]
let nodes = []; // aggregated nodes across loaded routes

// Coordinate picking state
let clickMarker = null;
let isCoordinateMode = false;
let coordinateModeType = 'start'; // 'start' or 'end'
let startPointMarker = null;
let endPointMarker = null;
let startPointCoords = null;
let endPointCoords = null;

// Poles state
const poleSetsData = new Map(); // key -> parsed pole list
let poles = [];
let poleCodeIndex = new Map(); // normCode -> Array<pole>
let nodeCodeIndex = new Map(); // normCode -> Array<node>

// Candidate containers
let startNearbyCandidates = [];
let endNearbyCandidates = [];

// Map alternate/missing node IDs to canonical node IDs
let nodeIdMap = new Map();
