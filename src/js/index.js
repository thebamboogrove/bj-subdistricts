const map = L.map('map').setView([0, 0], 2);
L.maptiler.maptilerLayer({ style: `https://api.maptiler.com/maps/0196b3ae-e9c9-7d17-8eba-f7e3a737a043/style.json`, apiKey: 'SZkfn0kRolWBGm2hTWcb' }).addTo(map);
L.control.locate({ position: 'topleft', setView: 'once', flyTo: true }).addTo(map);

const allBounds = [];
const labelMarkers = [];
const geoJsonLayers = [];

function normalizeLabelPoint(p) {
    if (Array.isArray(p) && p.length === 2) {
        const [lng, lat] = p.map(Number);
        if (isFinite(lat) && isFinite(lng)) return [lng, lat];
    }
    return null;
}
fetch('./src/boundaries/index.json')
    .then(res => res.json())
    .then(config => {
        const styles = config.styles || {};
        const entries = config.layers || [];
        return Promise.all(entries.map(entry =>
            fetch(entry.file).then(res => res.json()).then(data => {
                const ref = entry.styleRef && styles[entry.styleRef] ? styles[entry.styleRef] : {};
                const defaultStyle = ref.default || {};
                const styleMapDef = ref.styleMap || entry.styleMap;
                const popupToggle = ref.popupFilter != null ? ref.popupFilter : entry.popupFilter;
                const interactiveFlag = ref.interactive != null ? ref.interactive : (entry.interactive != null ? entry.interactive : true);
                const labelCfg = ref.labelConfig || entry.labelConfig;
                const styleFn = feature => {
                    const zoom = map.getZoom();
                    let style = { ...defaultStyle };
                    if (styleMapDef && styleMapDef.property) {
                        const v = feature.properties[styleMapDef.property];
                        if (styleMapDef.map && String(v) in styleMapDef.map) {
                            Object.assign(style, styleMapDef.map[String(v)]);
                        }
                    }
                    if (entry.zoomStyles) {
                        entry.zoomStyles.forEach(zs => {
                            if ((zs.minZoom == null || zoom >= zs.minZoom) && (zs.maxZoom == null || zoom <= zs.maxZoom)) {
                                Object.assign(style, zs.style);
                            }
                        });
                    }
                    if (entry.useFeatureProperties) {
                        entry.useFeatureProperties.forEach(prop => {
                            if (feature.properties[prop] != null) style[prop] = feature.properties[prop];
                        });
                    }
                    if (!entry.styleRef && entry.style) {
                        Object.assign(style, entry.style);
                    }
                    style.interactive = interactiveFlag;
                    return style;
                };

                const layer = L.geoJSON(data, {
                    style: styleFn,
                    onEachFeature: (feature, lyr) => {
                        if (interactiveFlag) {
                            if (popupToggle === true) lyr.bindPopup(feature.properties.Name);
                        }
                        if (labelCfg) {
                            const coords = normalizeLabelPoint(feature.properties.labelPoint);
                            if (coords) lyr.once('add', () => {
                                const [lng, lat] = coords;
                                const color = feature.properties[labelCfg.colorProp] || labelCfg.defaultColor;
                                const size = labelCfg.fontSize || '14pt';
                                const weight = labelCfg.fontWeight || '400';
                                const html = `<div class='label-div' style='color:${color}; font-size:${size}; font-weight:${weight};'>${feature.properties[labelCfg.property]}</div>`;
                                const m = L.marker([lng, lat], { icon: L.divIcon({ html, iconAnchor: [0,0] }), interactive: false }).addTo(map);
                                labelMarkers.push({ marker: m, minZoom: labelCfg.minZoom, maxZoom: labelCfg.maxZoom || Infinity });
                            });
                        }
                    }
                }).addTo(map);

                allBounds.push(layer.getBounds());
                geoJsonLayers.push({ layer, styleFn });
            }).catch(err => console.error(`Error loading ${entry.file}:`, err))
        ));
    })
    .then(() => {
        const valid = allBounds.filter(b => b.isValid());
        if (valid.length) {
            const combined = valid.reduce((a, b) => a.extend(b), valid[0]);
            map.fitBounds(combined);
            map.setMaxBounds(combined);
            map.options.minZoom = map.getZoom();
        }
    })
    .catch(err => console.error('Error loading boundaries:', err));

function updateLabelVisibility() {
    const z = map.getZoom();
    labelMarkers.forEach(({ marker, minZoom, maxZoom }) => {
        if (z >= minZoom && z <= maxZoom) map.addLayer(marker);
        else map.removeLayer(marker);
    });
}

function updateLayerStyles() {
    geoJsonLayers.forEach(({ layer, styleFn }) => {
        layer.eachLayer(l => { if (l.setStyle) l.setStyle(styleFn(l.feature)); });
    });
}

map.on('zoomend', () => { updateLabelVisibility(); updateLayerStyles(); });
map.whenReady(() => { updateLabelVisibility(); updateLayerStyles(); });