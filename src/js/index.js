// TODO: better indexDB + cleanup functionality
// TODO: refactor everything
// indexDB geojson cache
class GeoJSONCache {
    constructor() {
        this.dbName = 'GeoJSONCache';
        this.version = 104;
        this.storeName = 'geojson';
        this.db = null;
        this.compressionSupported = typeof CompressionStream !== 'undefined';
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
                if (db.objectStoreNames.contains(this.storeName)) {
                    db.deleteObjectStore(this.storeName);
                }
                db.createObjectStore(this.storeName, {keyPath: 'url'});
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
                if (result && Date.now() - result.timestamp < 7 * 24 * 60 * 60 * 1000) {
                    if (result.compressed && this.compressionSupported) {
                        this.decompressData(result.data).then(resolve).catch(() => resolve(null));
                    } else {
                        resolve(result.data);
                    }
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

        let storeData = data;
        let compressed = false;

        if (this.compressionSupported && typeof data === 'object') {
            try {
                storeData = await this.compressData(JSON.stringify(data));
                compressed = true;
            } catch (error) {
                console.warn('indexedDB compression failed', error);
                storeData = data;
            }
        }

        store.put({
            url, data: storeData, compressed, timestamp: Date.now()
        });
    }

    async compressData(text) {
        const stream = new CompressionStream('gzip');
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();

        writer.write(new TextEncoder().encode(text));
        writer.close();

        const chunks = [];
        let done = false;

        while (!done) {
            const {value, done: readerDone} = await reader.read();
            done = readerDone;
            if (value) chunks.push(value);
        }

        return new Uint8Array(chunks.reduce((acc, chunk) => [...acc, ...chunk], []));
    }

    async decompressData(compressedData) {
        const stream = new DecompressionStream('gzip');
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();

        writer.write(compressedData);
        writer.close();

        const chunks = [];
        let done = false;

        while (!done) {
            const {value, done: readerDone} = await reader.read();
            done = readerDone;
            if (value) chunks.push(value);
        }

        const decompressed = new Uint8Array(chunks.reduce((acc, chunk) => [...acc, ...chunk], []));
        const text = new TextDecoder().decode(decompressed);
        return JSON.parse(text);
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
            district: {fill: '#ff6b35', stroke: '#ff4500'}, subdistrict: {fill: '#4ecdc4', stroke: '#26a69a'}
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
            id: `${id}-fill`, type: 'fill', source: id, paint: {
                'fill-color': color.fill, 'fill-opacity': 0.6
            }
        });

        this.map.addLayer({
            id: `${id}-stroke`, type: 'line', source: id, paint: {
                'line-color': color.stroke, 'line-width': 3
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

class SearchIndex {
    constructor() {
        this.items = [];
        this.fuse = null;
        this.isReady = false;
        this.lastQuery = '';
        this.lastResults = [];
    }

    addItem(item) {
        this.items.push(item);
        this.fuse = null;
        this.isReady = false;
    }

    addItems(items) {
        this.items.push(...items);
        this.fuse = null;
        this.isReady = false;
    }

    async initializeFuse() {
        if (this.fuse) return;

        if (typeof Fuse === 'undefined') {
            throw new Error('Fuse.js not loaded');
        }

        this.fuse = new Fuse(this.items, {
            keys: [{
                name: 'name', weight: 0.6, threshold: 0.4, distance: 100
            }, {
                name: 'code', weight: 0.3, threshold: 0.1, distance: 10
            }, {
                name: 'pinyin', weight: 0.1, threshold: 0.3, distance: 50
            }],
            includeScore: true,
            includeMatches: true,
            ignoreLocation: true,
            findAllMatches: true,
            minMatchCharLength: 1,
            shouldSort: true,
            threshold: 0.4,
            distance: 100
        });

        this.isReady = true;
    }

    search(query, limit = 10) {
        if (!this.isReady || !this.fuse) {
            return [];
        }

        if (query === this.lastQuery && this.lastResults.length > 0) {
            return this.lastResults.slice(0, limit);
        }

        const isNumericQuery = /^\d+$/.test(query);
        let results = this.fuse.search(query).slice(0, limit);

        if (isNumericQuery) {
            results = results.filter(result => {
                const hasCodeMatch = result.matches && result.matches.some(m => m.key === 'code');
                if (hasCodeMatch) {
                    return result.item.code.startsWith(query);
                }
                return true;
            });
        }

        this.lastQuery = query;
        this.lastResults = results;
        return results;
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
        this.searchIndex = new SearchIndex();
        this.searchInitialized = false;
        this.compressionSupported = this.checkCompressionSupport();

        this.markingCache = null;
        this.markingManager = null;
        this.markingControl = null;

        this.loadingState = {
            districts: false, subdistricts: false, specialLayers: false, labels: false, search: false, marking: false
        }
    }

    checkCompressionSupport() {
        return typeof DecompressionStream !== 'undefined';
    }

    async fetchJSON(url, options = {}) {
        const {enableCompression = true, retries = 3} = options;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                let data = await this.cache.get(url);
                if (data) return data;

                if (enableCompression && this.compressionSupported && (url.includes('.geojson') || url.includes('/boundaries/'))) {

                    try {
                        const gzipUrl = url + '.gz';
                        const response = await fetch(gzipUrl);
                        if (response.ok) {
                            const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
                            const decompressedResponse = new Response(stream);
                            data = await decompressedResponse.json();
                        }
                    } catch (error) {
                        console.log(`Compressed fetch failed for ${url}, attempt ${attempt}:`, error);
                    }
                }

                if (!data) {
                    const response = await fetch(url);
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                    data = await response.json();
                }

                await this.cache.set(url, data);
                return data;

            } catch (error) {
                console.error(`Fetch attempt ${attempt} failed for ${url}:`, error);

                if (attempt === retries) {
                    throw new Error(`Failed to fetch ${url} after ${retries} attempts: ${error.message}`);
                }

                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }

    async init() {
        try {
            this.loader.setTotal(8); // map, districts, subdistricts, special, labels, search, marking, complete

            // index+map schema
            const [config, style] = await Promise.all([this.fetchJSON('./src/boundaries/index.json', {enableCompression: false}), this.fetchJSON('./src/schema/basic_minlabel.json', {enableCompression: false})]);

            this.config = config;

            this.map = new maplibregl.Map({
                container: 'map', style, zoom: 10, pitchWithRotate: false
            });

            this.highlighter = new FeatureHighlighter(this.map);
            this.setupMapBounds();
            this.setupMapControls();
            this.loader.step('Map initializing');

            this.map.on('load', async () => {
                await this.loadAllLayersParallel();
                await this.setupSearch();
                await this.setupMarkingSystem();
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
            }, trackUserLocation: true, showUserHeading: true
        }), 'top-left');
        this.map.addControl(new SearchControl(), 'top-right');
    }

    async setupMarkingSystem() {
        try {
            this.loader.step('Initializing marking system');
            await import('./marking-system.js');

            this.markingCache = new MarkingCache();
            this.markingManager = new MarkingManager(this.map, this.markingCache);
            this.markingManager.setSearchIndex(this.searchIndex.items);

            await this.markingManager.init();

            this.markingManager.applyAllFeatureStates();
            this.markingManager.updatePaintProperties();

            this.markingControl = new MarkingControl(this.markingManager, this.searchIndex.items);
            this.map.addControl(this.markingControl, 'top-right');

        } catch (error) {
            console.error('Failed to setup marking system:', error);
            this.loader.step('Marking system unavailable');
        }
    }

    setupMapBounds() {
        const bounds = [[115.41686, 39.4415], [117.50904, 41.05923]];
        this.map.fitBounds(bounds, {padding: 40});

        const padding = 0.6;
        const [sw, ne] = bounds;
        const lngPad = (ne[0] - sw[0]) * padding;
        const latPad = (ne[1] - sw[1]) * padding;
        const maxBounds = [[sw[0] - lngPad, sw[1] - latPad], [ne[0] + lngPad, ne[1] + latPad]];
        this.map.setMaxBounds(maxBounds);
    }

    async loadAllLayersParallel() {
        try {
            const layerOperations = [];

            if (this.config.districtOutlines?.length) {
                layerOperations.push({
                    type: 'districts', operation: () => this.loadDistrictsParallel()
                });
            }

            if (this.config.subdistrictLayers?.length) {
                layerOperations.push({
                    type: 'subdistricts', operation: () => this.loadSubdistrictsParallel()
                });
            }

            if (this.config.specialLayers?.length) {
                layerOperations.push({
                    type: 'special', operation: () => this.loadSpecialLayersParallel()
                });
            }

            if (this.config.cityOutline) {
                layerOperations.push({
                    type: 'city', operation: () => this.addLayer('city-outline', this.config.cityOutline, 'cityOutline')
                });
            }

            await this.executeWithConcurrencyLimit(layerOperations, 3);

            this.loader.step('Adding labels');
            await this.addLabelsParallel();

        } catch (error) {
            console.error('Failed to load layers in parallel:', error);
            throw error;
        }
    }

    async executeWithConcurrencyLimit(operations, limit = 3) {
        const results = [];
        const executing = [];

        for (const op of operations) {
            const promise = op.operation().then(result => {
                executing.splice(executing.indexOf(promise), 1);
                this.loader.step(`Loading ${op.type}`);
                return result;
            });

            results.push(promise);
            executing.push(promise);

            if (executing.length >= limit) {
                await Promise.race(executing);
            }
        }

        return Promise.all(results);
    }

    async loadDistrictsParallel() {
        const districtPromises = this.config.districtOutlines.map(file => this.loadAndProcessDistrictData(file));

        const districtDataArray = await Promise.all(districtPromises);

        for (const {name, data, file} of districtDataArray) {
            await this.addDistrictLayerToMap(name, data, file);
        }

        this.loadingState.districts = true;
    }

    async loadAndProcessDistrictData(file) {
        const name = file.split('/').pop().replace('.geojson', '');
        const data = await this.fetchJSON(file);
        const searchItems = [];
        data.features.forEach(feature => {
            const props = feature.properties || {};
            if (props.Name) {
                let featureId = this.generateFeatureId(props, 100000); // offset for districts

                searchItems.push({
                    name: props.Name,
                    code: String(props.code || ''),
                    pinyin: props.pinyin || '',
                    type: 'district',
                    feature,
                    featureId,
                    sourceId: `${name}-outline`
                });
            }
        });
        this.searchIndex.addItems(searchItems);
        return {name, data, file};
    }

    async addDistrictLayerToMap(name, data, file) {
        const id = `${name}-outline`;
        const style = this.config.styles.districtOutline;

        this.map.addSource(id, {
            type: 'geojson', data, maxzoom: 12, tolerance: 0.4, buffer: 128
        });

        this.map.addLayer({
            id, type: style.type, source: id, paint: style.paint, layout: style.layout || {}
        });
    }

    async loadSubdistrictsParallel() {
        const subdistrictPromises = this.config.subdistrictLayers.map(file => this.loadAndProcessSubdistrictData(file));
        const subdistrictDataArray = await Promise.all(subdistrictPromises);
        for (const {name, data} of subdistrictDataArray) {
            await this.addSubdistrictLayerToMap(name, data);
        }
        this.loadingState.subdistricts = true;
    }

    async loadAndProcessSubdistrictData(file) {
        const name = file.split('/').pop().replace('.geojson', '');
        const data = await this.fetchJSON(file);
        const searchItems = [];
        data.features.forEach((feature, index) => {
            const props = feature.properties || {};
            if (props.Name) {
                let featureId = this.generateFeatureId(props);
                feature.id = featureId;

                searchItems.push({
                    name: props.Name,
                    code: String(props.code || ''),
                    pinyin: props.pinyin || '',
                    type: 'subdistrict',
                    feature,
                    featureId,
                    sourceId: `${name}-source`
                });
            }
        });
        this.searchIndex.addItems(searchItems);
        return {name, data};
    }

    async addSubdistrictLayerToMap(name, data) {
        this.map.addSource(`${name}-source`, {
            type: 'geojson', data, maxzoom: 12, tolerance: 0.4, buffer: 128
        });

        this.map.addLayer({
            id: `${name}-fill`, type: 'fill', source: `${name}-source`, paint: {
                'fill-color': ['case', ['boolean', ['feature-state', 'marked'], false], '#1e56e4', ['boolean', ['feature-state', 'unmarked'], false], '#a34b4b', ['match', ['get', 'color_id'], 1, '#e41e32', 2, '#ff782a', 3, '#e2cf04', 4, '#98c217', 5, '#3f64ce', 6, '#7e2b8e', '#cccccc']],
                'fill-opacity': ['case', ['boolean', ['feature-state', 'marked'], false], 0.8, ['boolean', ['feature-state', 'unmarked'], false], 0.2, 0.2]
            }
        });

        this.map.addLayer({
            id: `${name}-line`, type: 'line', source: `${name}-source`, paint: this.config.styles.subdistrictLine.paint
        });
    }

    async loadSpecialLayersParallel() {
        const specialPromises = this.config.specialLayers.map(special => {
            const id = special.file.split('/').pop().replace('.geojson', '');
            return this.addLayer(id, special.file, special.styleRef);
        });

        await Promise.all(specialPromises);
        this.loadingState.special = true;
    }

    async addLabelsParallel() {
        const labelPromises = [];
        if (this.config.subdistrictLayers) {
            labelPromises.push(...this.config.subdistrictLayers.map(file => this.addLabelLayer(file, 'subdistrict')));
        }

        if (this.config.districtOutlines) {
            labelPromises.push(...this.config.districtOutlines.map(file => this.addLabelLayer(file, 'district')));
        }

        await Promise.all(labelPromises);
        this.loadingState.labels = true;
    }

    generateFeatureId(props, offset = 0) {
        if (typeof props.code === 'string' && /^\d+$/.test(props.code)) {
            return parseInt(props.code, 10) + offset;
        } else if (typeof props.code === 'number' && Number.isInteger(props.code)) {
            return props.code + offset;
        } else {
            // really unnecessary
            let hash = 0;
            const nameStr = props.Name || 'unknown';
            for (let i = 0; i < nameStr.length; i++) {
                hash = ((hash << 5) - hash) + nameStr.charCodeAt(i);
                hash |= 0;
            }
            return Math.abs(hash) + offset;
        }
    }

    async addLayer(id, file, styleRef) {
        const data = await this.fetchJSON(file);
        const style = this.config.styles[styleRef];

        this.map.addSource(id, {type: 'geojson', data, maxzoom: 12, tolerance: 0.4, buffer: 128});
        this.map.addLayer({
            id, type: style.type, source: id, paint: style.paint, layout: style.layout || {}
        });
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
                        type: 'Feature', properties: {Name: props.Name}, geometry: {
                            type: 'Point', coordinates: [labelPoint[1], labelPoint[0]]
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
                    highlights.push({start, end});
                });
            });

            highlights.sort((a, b) => b.start - a.start);

            highlights.forEach(({start, end}) => {
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
        try {
            await this.searchIndex.initializeFuse();

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

            collapseSearch();

            const awesomplete = new Awesomplete(searchInput, {
                minChars: 1, maxItems: 10, autoFirst: true, filter: () => true, item: (text, input) => {
                    const data = JSON.parse(text.value);
                    return this.createSearchItem(data.item, data.matches);
                }
            });
            let searchTimeout;
            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.trim();

                clearTimeout(searchTimeout);

                if (query.length === 0) {
                    awesomplete.list = [];
                    return;
                }
                searchTimeout = setTimeout(() => {
                    const results = this.searchIndex.search(query, 10);

                    awesomplete.list = results.map(result => ({
                        label: this.formatResult(result.item), value: JSON.stringify({
                            item: result.item, matches: result.matches || []
                        })
                    }));
                }, 100);
            });

            searchInput.addEventListener('awesomplete-selectcomplete', (e) => {
                const data = JSON.parse(e.text.value);
                const item = data.item;
                searchInput.value = item.name;

                this.fitToFeature(item.feature);
                this.highlighter.highlight(item.feature, item.type);
            });

            this.searchInitialized = true;
            this.loader.step('Search ready');

            console.log(`Search index found ${this.searchIndex.items.length} items`);

        } catch (error) {
            console.error('Failed to setup search:', error);
            this.loader.step('Search unavailable');
        }
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
            center: [centerLng, centerLat], zoom: zoom, duration: 1200, essential: true, // easeInOutCirc
            easing: (x) => {
                return x < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2;
            }
        });
    }

    setupPopups() {
        const popup = new maplibregl.Popup({
            closeButton: true, closeOnClick: false
        });

        const subdistrictLayers = (this.config.subdistrictLayers || [])
            .map(file => file.split('/').pop().replace('.geojson', '') + '-fill');

        subdistrictLayers.forEach(layerId => {
            this.map.on('click', layerId, (e) => {
                const feature = e.features[0];
                const name = feature.properties.Name || 'Unknown';
                const searchItem = this.searchIndex.items.find(item => item.name === name && item.type === 'subdistrict');
                let markButtonHtml = '';
                if (this.markingManager && searchItem) {
                    const isMarked = this.markingManager.isMarked(searchItem);
                    markButtonHtml = `
                    <button class="popup-mark-btn ${isMarked ? 'marked' : ''}" 
                            onclick="window.mapApp.toggleFeatureMarking('${name}', 'subdistrict', ${!isMarked})">
                        ${isMarked ? 'Unmark' : 'Mark'} Sub-district
                    </button>
                `;
                }

                popup.setLngLat(e.lngLat)
                    .setHTML(`
                    <div style="font-weight: 500;">${name}</div>
                    ${markButtonHtml}
                `)
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

    async toggleFeatureMarking(featureName, type, marked) {
        if (!this.markingManager) return;

        await this.markingManager.markFeatureByName(featureName, type, marked);

        if (this.markingControl && this.markingControl.isOpen) {
            this.markingControl.updatePanel();
        }

        const popups = document.getElementsByClassName('maplibregl-popup');
        if (popups.length > 0) {
            popups[0].remove();
        }
    }
}

window.mapApp = new MapApp();
window.mapApp.init();