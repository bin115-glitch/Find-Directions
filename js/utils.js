// ========== Utility Functions ==========

// Parse latlng strings like "(lat,lng);(lat,lng)"
function parseLatLngString(str) {
    if (!str) return [];
    return String(str).split(';').map(p => {
        const m = (p || '').match(/-?\d+(?:\.\d+)?/g);
        if (!m || m.length < 2) return null;
        return [parseFloat(m[0]), parseFloat(m[1])];
    }).filter(Boolean);
}

// Parse pole table array from JSON
function parsePoleTableArray(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(p => {
        let lat = null;
        let lng = null;
        if (p.lat != null && p.lng != null) {
            lat = parseFloat(p.lat);
            lng = parseFloat(p.lng);
        } else {
            const latlng = String(p.latlng || '').match(/-?\d+(?:\.\d+)?/g);
            if (!latlng || latlng.length < 2) return null;
            lat = parseFloat(latlng[0]);
            lng = parseFloat(latlng[1]);
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {
            id: p.id || p.code || p.name || 'pole',
            code: p.code || '',
            trubangduonglist: p.trubangduonglist || '',
            aheadcode: p.aheadcode || '',
            lat,
            lng,
            type: p.type || p.typedevice || 'cot',
            name: p.name || ''
        };
    }).filter(Boolean);
}

// Normalize code string for matching (trim, uppercase)
function normalizeCode(s) {
    if (!s && s !== 0) return '';
    return String(s).toUpperCase().replace(/\s+/g, '');
}

// Parse trubangduonglist string into array of normalized codes
function parseTruBangDuongList(listStr) {
    if (!listStr) return [];
    return String(listStr).split(/[;,|\s]+/).map(x => normalizeCode(x)).filter(Boolean);
}

// Haversine distance calculation (km)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Fit map to bounds of lat/lng array
function fitMapToLatLngs(latlngs) {
    if (!Array.isArray(latlngs) || !latlngs.length) return;
    const bounds = [];
    latlngs.forEach(pt => {
        if (!pt || pt.length < 2) return;
        const lat = Number(pt[0]);
        const lng = Number(pt[1]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            bounds.push([lat, lng]);
        }
    });
    if (bounds.length) {
        try { map.fitBounds(bounds, { padding: [20, 20] }); } catch (e) { }
    }
}

// Get node coordinates from node object
function getNodeCoordinatesSimple(node) {
    if (!node || !node.latlng) return null;
    const m = ('' + node.latlng).match(/-?\d+(?:\.\d+)?/g);
    if (!m || m.length < 2) return null;
    return [parseFloat(m[0]), parseFloat(m[1])];
}

// Classify node type
function classifyNodeType(typeValue) {
    if (typeValue == null) return 'other';
    const num = parseInt(typeValue);
    if (!isNaN(num)) {
        if (num === 1) return 'pop';
        if (num === 2 || num === 3) return 'cabinet';
        if (num === 4) return 'splice';
    }
    const s = ('' + typeValue).toLowerCase();
    if (s === 'g.652d') return 'splice';
    return 'other';
}

// Node icons
const nodeIcons = {
    pop: L.icon({ iconUrl: './icon/pop.gif', iconSize: [10, 10], iconAnchor: [10, 10] }),
    cabinet: L.icon({ iconUrl: './icon/TC_ADSL.gif', iconSize: [10, 10], iconAnchor: [10, 10] }),
    splice: L.icon({ iconUrl: './icon/mangxong.png', iconSize: [10, 10], iconAnchor: [9, 9] }),
    dot: L.divIcon({ html: '<div style="width:10px;height:10px;opacity:.9"></div>', className: '', iconSize: [10, 10], iconAnchor: [5, 5] })
};
