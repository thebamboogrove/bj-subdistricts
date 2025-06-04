// TODO: better indexDB + cleanup functionality
// indexDB geojson cache
class GeoJSONCache {
    constructor() {
        this.dbName = 'GeoJSONCache';
        this.version = 100;
        this.storeName = 'geojson';
        this.db = null;
    }

    async init() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, {keyPath: 'url'});
                }
            };
        });
    }

    async get(url) {
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction([this.storeName], 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(url);
            request.onsuccess = () => {
                const result = request.result;
                // Simple 7-day expiry
                if (result && Date.now() - result.timestamp < 7 * 24 * 60 * 60 * 1000) {
                    resolve(result.data);
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => resolve(null);
        });
    }

    async set(url, data) {
        await this.init();
        const tx = this.db.transaction([this.storeName], 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put({url, data, timestamp: Date.now()});
    }
}

// search control -> map controls
class SearchControl {
    constructor() {
        this._container = null;
    }

    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        this._container.id = 'search-container';
        this._container.title = 'Search boundaries';

        const searchInput = document.createElement('input');
        searchInput.id = 'search';
        searchInput.placeholder = '';
        searchInput.autocomplete = 'off';

        this._container.appendChild(searchInput);

        return this._container;
    }

    onRemove() {
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
    }
}
// TODO: Loading function rework
// loading function
class LoadingManager {
    constructor() {
        this.current = 0;
        this.total = 0;
        this.element = this.createUI();
    }

    createUI() {
        const overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.innerHTML = `
            <div class="loading-content">
                <div class="loading-spinner"></div>
                <div class="loading-header">Loading Map...</div>
                <div class="loading-text">Initializing map</div>
                <div class="progress-bar">
                    <div class="progress-fill"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        return overlay;
    }

    setTotal(total) {
        this.total = total;
        this.current = 0;
    }

    step(message) {
        this.current++;
        const progress = (this.current / this.total) * 100;
        const fill = this.element.querySelector('.progress-fill');
        const text = this.element.querySelector('.loading-text');

        if (fill) fill.style.width = `${progress}%`;
        if (text) text.textContent = message;
    }

    hide() {
        if (this.element) {
            this.element.style.opacity = '0';
            setTimeout(() => this.element.remove(), 300);
        }
    }
}

// found features highlight
class FeatureHighlighter {
    constructor(map) {
        this.map = map;
        this.currentHighlight = null;
    }

    highlight(feature, type = 'subdistrict') {
        this.clear();

        const id = `highlight-${Date.now()}`;
        // TODO: Better highlight colors?
        const colors = {
            district: {fill: '#ff6b35', stroke: '#ff4500'},
            subdistrict: {fill: '#4ecdc4', stroke: '#26a69a'}
        };
        const color = colors[type] || colors.subdistrict;

        this.map.addSource(id, {
            type: 'geojson',
            data: {type: 'FeatureCollection', features: [feature]},
            maxzoom: 12,
            tolerance: 0.4,
            buffer: 128
        });

        this.map.addLayer({
            id: `${id}-fill`,
            type: 'fill',
            source: id,
            paint: {
                'fill-color': color.fill,
                'fill-opacity': 0.6
            }
        });

        this.map.addLayer({
            id: `${id}-stroke`,
            type: 'line',
            source: id,
            paint: {
                'line-color': color.stroke,
                'line-width': 3
            }
        });

        this.currentHighlight = id;

        // TODO: Instead of clear w/ timeout use smoother animation?
        setTimeout(() => this.clear(), 3000);
    }

    clear() {
        if (this.currentHighlight) {
            const id = this.currentHighlight;
            if (this.map.getLayer(`${id}-fill`)) this.map.removeLayer(`${id}-fill`);
            if (this.map.getLayer(`${id}-stroke`)) this.map.removeLayer(`${id}-stroke`);
            if (this.map.getSource(id)) this.map.removeSource(id);
            this.currentHighlight = null;
        }
    }
}

// map app
class MapApp {
    constructor() {
        this.cache = new GeoJSONCache();
        this.loader = new LoadingManager();
        this.map = null;
        this.config = null;
        this.highlighter = null;
        this.searchIndex = [];
        this.fuse = null;
    }

    async fetchJSON(url) {
        let data = await this.cache.get(url);
        if (!data) {
            const response = await fetch(url);
            data = await response.json();
            await this.cache.set(url, data);
        }
        return data;
    }

    async init() {
        try {
            this.loader.setTotal(6); // map, districts, subdistricts, special, labels, search

            // index+map schema
            this.config = await this.fetchJSON('./src/boundaries/index.json');
            const style = await this.fetchJSON('./src/schema/basic_minlabel.json');

            this.map = new maplibregl.Map({
                container: 'map',
                style,
                zoom: 10,
                pitchWithRotate: false
            });

            this.highlighter = new FeatureHighlighter(this.map);
            this.setupMapBounds();
            this.setupMapControls();
            this.loader.step('Map initializing');

            this.map.on('load', async () => {
                await this.loadDistricts();
                await this.loadSubdistricts();
                await this.loadSpecialLayers();
                await this.addLabels();
                await this.setupSearch();
                this.setupPopups();
                this.loader.step('Complete!');
                setTimeout(() => this.loader.hide(), 500);
            });

        } catch (error) {
            console.error('Failed to initialize:', error);
            this.loader.hide();
        }
    }

    setupMapControls() {
        this.map.addControl(new maplibregl.NavigationControl(), 'top-left');
        this.map.addControl(new maplibregl.GeolocateControl({
            positionOptions: {
                enableHighAccuracy: true
            },
            trackUserLocation: true,
            showUserHeading: true
        }), 'top-left');
        this.map.addControl(new SearchControl(), 'top-right');
    }

    setupMapBounds() {
        const bounds = [[115.41686, 39.4415], [117.50904, 41.05923]];
        this.map.fitBounds(bounds, {padding: 40});

        const padding = 0.6;
        const [sw, ne] = bounds;
        const lngPad = (ne[0] - sw[0]) * padding;
        const latPad = (ne[1] - sw[1]) * padding;
        const maxBounds = [
            [sw[0] - lngPad, sw[1] - latPad],
            [ne[0] + lngPad, ne[1] + latPad]
        ];
        this.map.setMaxBounds(maxBounds);
    }

    async loadDistricts() {
        for (const file of this.config.districtOutlines || []) {
            await this.addDistrictLayer(file);
        }

        if (this.config.cityOutline) {
            await this.addLayer('city-outline', this.config.cityOutline, 'cityOutline');
        }

        this.loader.step('Loading districts');
    }

    async loadSubdistricts() {
        for (const file of this.config.subdistrictLayers || []) {
            await this.addSubdistrictLayer(file);
        }

        this.loader.step('Loading subdistricts');
    }

    async loadSpecialLayers() {
        for (const special of this.config.specialLayers || []) {
            await this.addLayer(
                special.file.split('/').pop().replace('.geojson', ''),
                special.file,
                special.styleRef
            );
        }

        this.loader.step('Loading special layers');
    }

    async addSubdistrictLayer(file) {
        const name = file.split('/').pop().replace('.geojson', '');
        const data = await this.fetchJSON(file);

        data.features.forEach(feature => {
            const props = feature.properties || {};
            if (props.Name) {
                this.searchIndex.push({
                    name: props.Name,
                    code: String(props.code || ''),
                    pinyin: props.pinyin || '',
                    type: 'subdistrict',
                    feature
                });
            }
        });

        this.map.addSource(`${name}-source`, {type: 'geojson', data, maxzoom: 12, tolerance: 0.4, buffer: 128});
        this.map.addLayer({
            id: `${name}-fill`,
            type: 'fill',
            source: `${name}-source`,
            paint: this.config.styles.subdistrictFill.paint
        });

        this.map.addLayer({
            id: `${name}-line`,
            type: 'line',
            source: `${name}-source`,
            paint: this.config.styles.subdistrictLine.paint
        });
    }

    async addDistrictLayer(file) {
        const name = file.split('/').pop().replace('.geojson', '');
        const data = await this.fetchJSON(file);

        data.features.forEach(feature => {
            const props = feature.properties || {};
            if (props.Name) {
                this.searchIndex.push({
                    name: props.Name,
                    code: String(props.code || ''),
                    pinyin: props.pinyin || '',
                    type: 'district',
                    feature
                });
            }
        });

        await this.addLayer(`${name}-outline`, file, 'districtOutline');
    }

    async addLayer(id, file, styleRef) {
        const data = await this.fetchJSON(file);
        const style = this.config.styles[styleRef];

        this.map.addSource(id, {type: 'geojson', data, maxzoom: 12, tolerance: 0.4, buffer: 128});
        this.map.addLayer({
            id,
            type: style.type,
            source: id,
            paint: style.paint,
            layout: style.layout || {}
        });
    }

    async addLabels() {
        for (const file of this.config.subdistrictLayers || []) {
            await this.addLabelLayer(file, 'subdistrict');
        }

        for (const file of this.config.districtOutlines || []) {
            await this.addLabelLayer(file, 'district');
        }

        this.loader.step('Adding labels');
    }

    async addLabelLayer(file, type) {
        const name = file.split('/').pop().replace('.geojson', '');
        const data = await this.fetchJSON(file);
        const defaults = this.config.labelLayerDefaults[type];

        const labelFeatures = data.features
            .map(feature => {
                const props = feature.properties || {};
                const labelPoint = props.labelPoint;
                if (labelPoint && Array.isArray(labelPoint) && labelPoint.length === 2) {
                    return {
                        type: 'Feature',
                        properties: {Name: props.Name},
                        geometry: {
                            type: 'Point',
                            coordinates: [labelPoint[1], labelPoint[0]]
                        }
                    };
                }
                return null;
            })
            .filter(f => f !== null);

        if (labelFeatures.length > 0) {
            const sourceId = `${name}-labels`;
            this.map.addSource(sourceId, {
                type: 'geojson',
                data: {type: 'FeatureCollection', features: labelFeatures},
                maxzoom: 12,
                tolerance: 0.4,
                buffer: 128
            });

            this.map.addLayer({
                id: sourceId,
                type: 'symbol',
                source: sourceId,
                minzoom: defaults.minzoom || (type === 'district' ? 8 : 10),
                maxzoom: defaults.maxzoom || (type === 'district' ? 12 : 22),
                layout: defaults.layout || {'text-field': ['get', 'Name']},
                paint: defaults.paint || {}
            });
        }
    }

    createSearchItem(item, matches = []) {
        const li = document.createElement('li');
        const typeLabel = item.type === 'district' ? '区' : '街道/乡镇';

        const applyHighlights = (text, fieldMatches) => {
            if (!fieldMatches || fieldMatches.length === 0) return text;

            let highlightedText = text;
            const highlights = [];

            fieldMatches.forEach(match => {
                match.indices.forEach(([start, end]) => {
                    highlights.push({ start, end });
                });
            });

            highlights.sort((a, b) => b.start - a.start);

            highlights.forEach(({ start, end }) => {
                const before = highlightedText.substring(0, start);
                const highlighted = highlightedText.substring(start, end + 1);
                const after = highlightedText.substring(end + 1);
                highlightedText = before + '<mark>' + highlighted + '</mark>' + after;
            });

            return highlightedText;
        };

        const nameMatches = matches.filter(m => m.key === 'name');
        const codeMatches = matches.filter(m => m.key === 'code');
        // TODO: Some clever pinyin highlighting?
        // const pinyinMatches = matches.filter(m => m.key === 'pinyin');

        const highlightedName = applyHighlights(item.name, nameMatches);
        const highlightedCode = applyHighlights(item.code, codeMatches);

        li.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span>${highlightedName}</span>
                <span style="font-size: 0.8em; color: #666;">${typeLabel}</span>
            </div>
            <div><span style="font-size: 0.8em; color: #888;">${highlightedCode}</span></div>
        `;
        return li;
    }

    async setupSearch() {
        // TODO: fuse.js weight adjustment
        this.fuse = new Fuse(this.searchIndex, {
            keys: [
                {
                    name: 'name',
                    weight: 0.6,
                    threshold: 0.4,
                    distance: 100
                },
                {
                    name: 'code',
                    weight: 0.3,
                    threshold: 0.1,
                    distance: 10
                },
                {
                    name: 'pinyin',
                    weight: 0.1,
                    threshold: 0.3,
                    distance: 50
                }
            ],
            includeScore: true,
            includeMatches: true,
            ignoreLocation: true,
            findAllMatches: true,
            minMatchCharLength: 1
        });

        const searchInput = document.getElementById('search');
        if (!searchInput) return;
        const SEARCH_PLACEHOLDER = "Search boundaries...";

        function expandSearch() {
            searchInput.classList.add('expanded');
            searchInput.setAttribute('placeholder', SEARCH_PLACEHOLDER);
        }

        function collapseSearch() {
            searchInput.classList.remove('expanded');
            searchInput.setAttribute('placeholder', '');
        }

        searchInput.addEventListener('focus', expandSearch);
        searchInput.addEventListener('blur', function () {
            if (!searchInput.value) collapseSearch();
        });
        searchInput.addEventListener('click', expandSearch);

        //TODO: Add a clear search button

        collapseSearch();

        const awesomplete = new Awesomplete(searchInput, {
            minChars: 1,
            maxItems: 10,
            autoFirst: true,
            filter: () => true,
            item: (text, input) => {
                const data = JSON.parse(text.value);
                return this.createSearchItem(data.item, data.matches);
            }
        });

        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();

            if (query.length === 0) {
                awesomplete.list = [];
                return;
            }

            const isNumericQuery = /^\d+$/.test(query);
            let results = this.fuse.search(query).slice(0, 10);

            if (isNumericQuery) {
                results = results.filter(result => {
                    const hasCodeMatch = result.matches && result.matches.some(m => m.key === 'code');
                    if (hasCodeMatch) {
                        return result.item.code.startsWith(query);
                    }
                    return true;
                });
            }
            awesomplete.list = results.map(result => ({
                label: this.formatResult(result.item),
                value: JSON.stringify({
                    item: result.item,
                    matches: result.matches || []
                })
            }));
        });

        searchInput.addEventListener('awesomplete-selectcomplete', (e) => {
            const data = JSON.parse(e.text.value);
            const item = data.item;
            searchInput.value = item.name;

            this.fitToFeature(item.feature);
            this.highlighter.highlight(item.feature, item.type);
        });

        this.loader.step('Initializing search');
    }

    formatResult(item) {
        const typeLabel = item.type === 'district' ? '区' : '街道/乡镇';
        return `${item.name} - ${typeLabel}`;
    }

    fitToFeature(feature) {
        if (!feature.geometry) return;

        const coords = [];
        const extractCoords = (c) => {
            if (typeof c[0] === 'number') {
                coords.push(c);
            } else {
                c.forEach(extractCoords);
            }
        };
        extractCoords(feature.geometry.coordinates);

        if (coords.length === 0) return;

        let minLng = coords[0][0], minLat = coords[0][1];
        let maxLng = coords[0][0], maxLat = coords[0][1];

        coords.forEach(([lng, lat]) => {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        });

        const centerLng = (minLng + maxLng) / 2;
        const centerLat = (minLat + maxLat) / 2;

        const lngDiff = maxLng - minLng;
        const latDiff = maxLat - minLat;

        const mapContainer = this.map.getContainer();
        const containerWidth = mapContainer.offsetWidth;
        const containerHeight = mapContainer.offsetHeight;

        const padding = 100;
        const availableWidth = containerWidth - (padding * 2);
        const availableHeight = containerHeight - (padding * 2);

        const lngZoom = Math.log2(360 * availableWidth / (lngDiff * 256));
        const latZoom = Math.log2(180 * availableHeight / (latDiff * 256));

        let zoom = Math.min(lngZoom, latZoom);
        zoom = Math.min(14, Math.max(8, zoom));
        //fly me to the moon
        this.map.flyTo({
            center: [centerLng, centerLat],
            zoom: zoom,
            duration: 1200,
            essential: true,
            // easeInOutCirc
            easing: (x) => {
                return x < 0.5
                    ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2
                    : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2;
            }
        });
    }

    setupPopups() {
        const popup = new maplibregl.Popup({
            closeButton: true,
            closeOnClick: false
        });

        const subdistrictLayers = (this.config.subdistrictLayers || [])
            .map(file => file.split('/').pop().replace('.geojson', '') + '-fill');

        subdistrictLayers.forEach(layerId => {
            this.map.on('click', layerId, (e) => {
                const feature = e.features[0];
                const name = feature.properties.Name || 'Unknown';
                popup.setLngLat(e.lngLat)
                    .setHTML(`<div style="font-weight: 500;">${name}</div>`)
                    .addTo(this.map);
            });

            this.map.on('mouseenter', layerId, () => {
                this.map.getCanvas().style.cursor = 'pointer';
            });

            this.map.on('mouseleave', layerId, () => {
                this.map.getCanvas().style.cursor = '';
            });
        });
    }
}

const app = new MapApp();
app.init();