// TODO: unbloatify, move stuff to index.js and add better error handling
// TODO: set variables for colors, opacity etc.?
// TODO: refactor everything here also
// mapApp.map.queryRenderedFeatures({layers: ['changping-all-fill']})

// maybe not extend?
class MarkingCache extends GeoJSONCache {
    constructor() {
        super();
        this.dbName = 'MapMarkingCache';
        this.version = 102;
        this.markingStoreName = 'markings';
        this.settingsStoreName = 'settings';
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
                if (db.objectStoreNames.contains(this.markingStoreName)) {
                    db.deleteObjectStore(this.markingStoreName);
                }
                db.createObjectStore(this.markingStoreName, {keyPath: 'id'});
                if (db.objectStoreNames.contains(this.settingsStoreName)) {
                    db.deleteObjectStore(this.settingsStoreName);
                }
                db.createObjectStore(this.settingsStoreName, {keyPath: 'key'});
            };
        });
    }

    async getMarkings() {
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction([this.markingStoreName], 'readonly');
            const store = tx.objectStore(this.markingStoreName);
            const request = store.getAll();
            request.onsuccess = () => {
                const markings = {};
                request.result.forEach(item => {
                    markings[item.id] = item.marked;
                });
                resolve(markings);
            };
            request.onerror = () => resolve({});
        });
    }

    async setMarking(id, marked) {
        await this.init();
        const tx = this.db.transaction([this.markingStoreName], 'readwrite');
        const store = tx.objectStore(this.markingStoreName);
        store.put({id, marked, timestamp: Date.now()});
    }

    async getSettings() {
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction([this.settingsStoreName], 'readonly');
            const store = tx.objectStore(this.settingsStoreName);
            const request = store.getAll();
            request.onsuccess = () => {
                const settings = {};
                request.result.forEach(item => {
                    settings[item.key] = item.value;
                });
                resolve(settings);
            };
            request.onerror = () => resolve({});
        });
    }

    async setSetting(key, value) {
        await this.init();
        const tx = this.db.transaction([this.settingsStoreName], 'readwrite');
        const store = tx.objectStore(this.settingsStoreName);
        store.put({key, value, timestamp: Date.now()});
    }

    async clearAllMarkings() {
        await this.init();
        const tx = this.db.transaction([this.markingStoreName], 'readwrite');
        const store = tx.objectStore(this.markingStoreName);
        store.clear();
    }
}

class MarkingManager {
    constructor(map, cache) {
        this.map = map;
        this.cache = cache;
        this.markings = {};
        this.settings = {
            markedVisible: false,
            unmarkedVisible: false,
            markedOpacity: 0.5,
            unmarkedOpacity: 0.5
        };
        this.initialized = false;
        this.searchIndex = null;
    }
    setSearchIndex(searchIndex) {
        this.searchIndex = searchIndex;
    }
    async init() {
        if (this.initialized) return;
        await this.cache.init();
        this.markings = await this.cache.getMarkings();
        const savedSettings = await this.cache.getSettings();
        this.settings = { ...this.settings, ...savedSettings };
        this.initialized = true;

        this.updatePaintProperties();
        this.applyAllFeatureStates();
    }

    updatePaintProperties() {
        const subdistrictLayers = this.map.getStyle().layers
            .filter(layer => layer.id.includes('-fill') && layer.source.includes('-source'))
            .map(layer => layer.id);

        subdistrictLayers.forEach(layerId => {
            this.map.setPaintProperty(layerId, 'fill-color', [
                'case',
                // visible marked
                ['all',
                    ['boolean', ['feature-state', 'marked'], false],
                    this.settings.markedVisible
                ],
                '#1e56e4',
                // visible unmarked
                ['all',
                    ['boolean', ['feature-state', 'unmarked'], false],
                    this.settings.unmarkedVisible
                ],
                '#a34b4b',
                // marked/unmarked but not visible
                ['case',
                    ['boolean', ['feature-state', 'marked'], false],
                    [
                        'match',
                        ['get', 'color_id'],
                        1, '#e41e32',
                        2, '#ff782a',
                        3, '#e2cf04',
                        4, '#98c217',
                        5, '#3f64ce',
                        6, '#7e2b8e',
                        '#cccccc'
                    ],
                    ['boolean', ['feature-state', 'unmarked'], false],
                    [
                        'match',
                        ['get', 'color_id'],
                        1, '#e41e32',
                        2, '#ff782a',
                        3, '#e2cf04',
                        4, '#98c217',
                        5, '#3f64ce',
                        6, '#7e2b8e',
                        '#cccccc'
                    ],
                    [
                        'match',
                        ['get', 'color_id'],
                        1, '#e41e32',
                        2, '#ff782a',
                        3, '#e2cf04',
                        4, '#98c217',
                        5, '#3f64ce',
                        6, '#7e2b8e',
                        '#cccccc'
                    ]
                ]
            ]);

            this.map.setPaintProperty(layerId, 'fill-opacity', [
                'case',
                ['all',
                    ['boolean', ['feature-state', 'marked'], false],
                    this.settings.markedVisible
                ],
                this.settings.markedOpacity,
                ['all',
                    ['boolean', ['feature-state', 'unmarked'], false],
                    this.settings.unmarkedVisible
                ],
                this.settings.unmarkedOpacity,
                0.2
            ]);
        });
    }

    toggleVisibility(type, visible) {
        if (type === 'marked') {
            this.settings.markedVisible = visible;
        } else if (type === 'unmarked') {
            this.settings.unmarkedVisible = visible;
        }
        if (this.cache && typeof this.cache.setSetting === 'function') {
            this.cache.setSetting('markedVisible', this.settings.markedVisible);
            this.cache.setSetting('unmarkedVisible', this.settings.unmarkedVisible);
        }
        this.updatePaintProperties();
    }

    setFeatureVisibility(options = {}) {
        if ('markedVisible' in options) {
            this.settings.markedVisible = options.markedVisible;
        }
        if ('unmarkedVisible' in options) {
            this.settings.unmarkedVisible = options.unmarkedVisible;
        }
        if ('markedOpacity' in options) {
            this.settings.markedOpacity = options.markedOpacity;
        }
        if ('unmarkedOpacity' in options) {
            this.settings.unmarkedOpacity = options.unmarkedOpacity;
        }
        if (this.cache && typeof this.cache.setSetting === 'function') {
            Object.entries(options).forEach(([key, value]) => {
                this.cache.setSetting(key, value);
            });
        }
        this.updatePaintProperties();
    }

    generateFeatureId(feature, type) {
        const props = feature.properties || {};
        let code = props.code;
        if (typeof code === 'string' && /^\d+$/.test(code)) {
            return parseInt(code, 10);
        } else if (typeof code === 'number' && Number.isInteger(code)) {
            return code;
        }
        // hashing prob unnecessary, but whatever
        const name = props.Name || props.name || 'unknown';
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = ((hash << 5) - hash) + name.charCodeAt(i);
            hash |= 0;
        }
        hash += type === 'district' ? 100000 : 0;
        return Math.abs(hash);
    }
    // TODO: Update this to use the new featureId logic
    generateFeatureKey(sourceId, featureId) {
        return (featureId);
    }

    async markFeature(searchItem, marked = true) {
        const featureId = (typeof searchItem.featureId !== 'undefined') ? searchItem.featureId : this.generateFeatureId(searchItem.feature, searchItem.type);
        const key = this.generateFeatureKey(searchItem.sourceId, featureId);
        this.markings[key] = marked ? 'marked' : 'unmarked';
        await this.cache.setMarking(key, this.markings[key]);
        this.map.setFeatureState(
            { source: searchItem.sourceId, id: featureId },
            {
                marked: marked,
                unmarked: !marked
            }
        );
        this.updatePaintProperties();
        return key;
    }

    async markFeatureByName(featureName, type, marked = true) {
        const searchItem = window.mapApp.searchIndex.items.find(item =>
            item.name === featureName && item.type === type
        );

        if (searchItem) {
            return await this.markFeature(searchItem, marked);
        }
        return null;
    }

    async markDistrictByCode(districtCode, marked = true) {
        const subdistrictsToMark = this.getSubdistrictsByParentCode(districtCode);
        const promises = subdistrictsToMark.map(searchItem =>
            this.markFeature(searchItem, marked)
        );
        await Promise.all(promises);
    }

    getSubdistrictsByParentCode(parentCode) {
        return window.mapApp.searchIndex.filter(item => {
            if (item.type !== 'subdistrict') return false;
            const props = item.feature.properties || {};
            return props.parentCode === parentCode;
        });
    }

    isMarked(searchItem) {
        const featureId = (typeof searchItem.featureId !== 'undefined') ? searchItem.featureId : this.generateFeatureId(searchItem.feature, searchItem.type);
        const key = this.generateFeatureKey(searchItem.sourceId, featureId);
        return this.markings[key] === 'marked';
    }

    isUnmarked(searchItem) {
        const featureId = (typeof searchItem.featureId !== 'undefined') ? searchItem.featureId : this.generateFeatureId(searchItem.feature, searchItem.type);
        const key = this.generateFeatureKey(searchItem.sourceId, featureId);
        return this.markings[key] === 'unmarked';
    }

    async updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        for (const [key, value] of Object.entries(newSettings)) {
            await this.cache.setSetting(key, value);
        }
        this.updatePaintProperties();
    }

    applyAllFeatureStates() {
        Object.entries(this.markings).forEach(([key, state]) => {
            const featureId = parseInt(key, 10);
            if (this.searchIndex) {
                this.searchIndex.forEach(item => {
                    if (item.featureId === featureId && this.map.getSource(item.sourceId)) {
                        this.map.setFeatureState(
                            { source: item.sourceId, id: featureId },
                            {
                                marked: state === 'marked',
                                unmarked: state === 'unmarked'
                            }
                        );
                    }
                });
            }
        });
        this.setDefaultUnmarkedStates();
        this.updatePaintProperties();
    }

    async clearAllMarkings() {
        Object.keys(this.markings).forEach(key => {
            const [sourceId, featureId] = key.split('-');
            const numericFeatureId = parseInt(featureId);

            if (this.map.getSource(sourceId)) {
                this.map.removeFeatureState(
                    { source: sourceId, id: numericFeatureId }
                );
            }
        });
        this.markings = {};
        await this.cache.clearAllMarkings();
        this.applyAllFeatureStates();
        this.updatePaintProperties();
    }
    setDefaultUnmarkedStates() {
        this.searchIndex.forEach(item => {
            if (item.type === 'subdistrict') {
                const key = this.generateFeatureKey(item.sourceId, item.featureId);
                if (!this.markings.hasOwnProperty(key)) {
                    this.markings[key] = 'unmarked';
                    this.map.setFeatureState(
                        { source: item.sourceId, id: item.featureId },
                        {
                            marked: false,
                            unmarked: true
                        }
                    );
                }
            }
        });
    }
    async exportMarkings() {
        return {
            markings: this.markings,
            settings: this.settings,
            timestamp: Date.now(),
            version: '2.0'
        };
    }

    async importMarkings(data) {
        try {
            await this.clearAllMarkings();
            if (data.markings) {
                this.markings = data.markings;
                for (const [key, state] of Object.entries(this.markings)) {
                    await this.cache.setMarking(key, state);
                }
                this.applyAllFeatureStates();
            }
            if (data.settings) {
                await this.updateSettings(data.settings);
            }
            return true;
        } catch (error) {
            console.error('Failed to import markings:', error);
            return false;
        }
    }
    getMarkedCount() {
        return Object.values(this.markings).filter(state => state === 'marked').length;
    }
    getTotalFeatureCount() {
        return Object.keys(this.markings).length;
    }
}
class MarkingControl {
    constructor(markingManager, searchIndex) {
        this.markingManager = markingManager;
        this.searchIndex = searchIndex;
        this._container = null;
        this._panel = null;
        this.isOpen = false;
        this.districtGroups = {};
        this.expandedDistricts = new Set(); // TODO: maybe just sep. methods instead
        this.buildDistrictGroups();
    }

    buildDistrictGroups() {
        const districts = {};
        this.searchIndex.forEach(item => {
            if (item.type === 'district') {
                const props = item.feature.properties || {};
                const districtCode = props.code;
                districts[districtCode] = {
                    name: item.name,
                    code: districtCode,
                    feature: item.feature,
                    subdistricts: []
                };
            }
        });
        this.searchIndex.forEach(item => {
            if (item.type === 'subdistrict') {
                const props = item.feature.properties || {};
                const parentCode = props.parentCode;
                if (districts[parentCode]) {
                    districts[parentCode].subdistricts.push(item);
                } else {
                    if (!districts['unknown']) {
                        districts['unknown'] = {
                            name: 'Unknown District',
                            code: 'unknown',
                            feature: null,
                            subdistricts: []
                        };
                    }
                    districts['unknown'].subdistricts.push(item);
                }
            }
        });
        this.districtGroups = districts;
        this.markingManager.getSubdistrictsByParentCode = (parentCode) => {
            const district = this.districtGroups[parentCode];
            return district ? district.subdistricts : [];
        };
        // grab unknowns
        const totalSubdistrictsInIndex = this.searchIndex.filter(item => item.type === 'subdistrict').length;
        let totalGrouped = 0;
        Object.values(this.districtGroups).forEach(d => {
            totalGrouped += d.subdistricts.length;
        });
    }

    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        this._container.title = 'Manage marked features';

        // ze marking control button
        const button = document.createElement('button');
        button.className = 'marking-control-btn';
        button.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 18.5l-3 -1.5l-6 3v-13l6 -3l6 3l6 -3v7.5" /><path d="M9 4v13" /><path d="M15 7v5.5" /><path d="M21.121 20.121a3 3 0 1 0 -4.242 0c.418 .419 1.125 1.045 2.121 1.879c1.051 -.89 1.759 -1.516 2.121 -1.879z" /><path d="M19 18v.01" />
            </svg>
        `;
        button.addEventListener('click', () => this.toggle());
        this._container.appendChild(button);
        this.createPanel();
        return this._container;
    }

    onRemove() {
        if (this._panel && this._panel.parentNode) {
            this._panel.parentNode.removeChild(this._panel);
        }
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
    }

    createPanel() {
        this._panel = document.createElement('div');
        this._panel.className = 'marking-panel';
        this._panel.style.display = 'none';

        this._panel.innerHTML = `
        <div class="marking-panel-header">
            <h3>Marked Features</h3>
            <button class="marking-panel-close">×</button>
        </div>
        
        <div class="marking-panel-content">
            <div class="marking-stats">
                <span class="marked-count">0</span> of <span class="total-count">0</span> marked
            </div>
            
            <div class="marking-controls">
                <div class="visibility-controls">
                    <div class="visibility-group">
                        <label><input type="checkbox" id="marked-visible" checked> Show marked</label>
                        <label class="opacity-control">Opacity: <input type="range" id="marked-opacity" min="0" max="1" step="0.1" value="0.8"></label>
                    </div>
                    <div class="visibility-group">
                        <label><input type="checkbox" id="unmarked-visible" checked> Show unmarked</label>
                        <label class="opacity-control">Opacity: <input type="range" id="unmarked-opacity" min="0" max="1" step="0.1" value="0.2"></label>
                    </div>
                </div>
            </div>
            
            <div class="marking-actions">
                <button id="clear-all-markings">Clear All</button>
                <button id="export-markings">Export</button>
                <button id="import-markings">Import</button>
                <input type="file" id="import-file" accept=".json" style="display: none;">
            </div>
            
            <div class="feature-list-container">
                <h4>Districts and Sub-districts</h4>
                <div class="feature-list"></div>
            </div>
            
        </div>
    `;

        document.body.appendChild(this._panel);
        this.setupEventListeners();
        this.updatePanel();
    }

    setupEventListeners() {
        this._panel.querySelector('.marking-panel-close').addEventListener('click', () => this.close());

        this._panel.querySelector('#marked-visible').addEventListener('change', (e) => {
            this.markingManager.toggleVisibility('marked', e.target.checked);
            this.updatePanel();
        });

        this._panel.querySelector('#unmarked-visible').addEventListener('change', (e) => {
            this.markingManager.toggleVisibility('unmarked', e.target.checked);
            this.updatePanel();
        });

        this._panel.querySelector('#marked-opacity').addEventListener('input', (e) => {
            this.markingManager.setFeatureVisibility({ markedOpacity: parseFloat(e.target.value) });
        });

        this._panel.querySelector('#unmarked-opacity').addEventListener('input', (e) => {
            this.markingManager.setFeatureVisibility({ unmarkedOpacity: parseFloat(e.target.value) });
        });

        this._panel.querySelector('#clear-all-markings').addEventListener('click', async () => {
            if (confirm('Clear all markings? (Export before clearing recommended)')) {
                await this.markingManager.clearAllMarkings();
                this.updatePanel();
            }
        });

        this._panel.querySelector('#export-markings').addEventListener('click', async () => {
            const data = await this.markingManager.exportMarkings();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `bj_subdistrict_markings_${new Date().toISOString().split('T')[0]+'-'+Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });

        this._panel.querySelector('#import-markings').addEventListener('click', () => {
            this._panel.querySelector('#import-file').click();
        });

        this._panel.querySelector('#import-file').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    const success = await this.markingManager.importMarkings(data);
                    if (success) {
                        alert('Markings imported successfully');
                        this.updatePanel();
                    } else {
                        alert('Failed to import markings');
                    }
                } catch (error) {
                    alert('Invalid file format. Blame the developer.');
                }
            }
        });
    }

    updatePanel() {
        if (!this._panel) return;
        let totalSubdistricts = 0;
        let markedSubdistricts = 0;
        Object.values(this.districtGroups).forEach(district => {
            totalSubdistricts += district.subdistricts.length;
            markedSubdistricts += district.subdistricts.filter(item => this.markingManager.isMarked(item)).length;
        });
        this._panel.querySelector('.marked-count').textContent = markedSubdistricts;
        this._panel.querySelector('.total-count').textContent = totalSubdistricts;
        this.updateFeatureList();

        const settings = this.markingManager.settings;
        this._panel.querySelector('#marked-visible').checked = settings.markedVisible;
        this._panel.querySelector('#unmarked-visible').checked = settings.unmarkedVisible;
        this._panel.querySelector('#marked-opacity').value = settings.markedOpacity;
        this._panel.querySelector('#unmarked-opacity').value = settings.unmarkedOpacity;
    }

    updateFeatureList() {
        const container = this._panel.querySelector('.feature-list');
        if (!container) return;

        container.innerHTML = '';

        const sortedDistricts = Object.values(this.districtGroups)
            .sort((a, b) => a.name.localeCompare(b.name));

        sortedDistricts.forEach(district => {
            const districtDiv = document.createElement('div');
            districtDiv.className = 'district-group';

            const markedSubdistricts = district.subdistricts.filter(item =>
                this.markingManager.isMarked(item)
            ).length;
            const totalSubdistricts = district.subdistricts.length;
            const allMarked = markedSubdistricts === totalSubdistricts && totalSubdistricts > 0;

            const isExpanded = this.expandedDistricts.has(district.code);
            const districtHeader = document.createElement('div');
            districtHeader.className = 'district-header';
            districtHeader.innerHTML = `
                <div class="district-info">
                    <span class="district-chevron" style="transform:rotate(${isExpanded ? '90deg' : '0deg'});">&#9654;</span>
                    <h5>${district.name}</h5>
                    <span class="district-stats">(${markedSubdistricts}/${totalSubdistricts})</span>
                </div>
                <button class="mark-district-btn header ${allMarked ? 'marked' : ''}" data-district-code="${district.code}">
                    ${allMarked ? 'Unmark All' : 'Mark All'}
                </button>
            `;

            const subdistrictList = document.createElement('div');
            subdistrictList.className = 'subdistrict-list';
            subdistrictList.style.display = isExpanded ? '' : 'none';

            const sortedSubdistricts = district.subdistricts
                .sort((a, b) => a.name.localeCompare(b.name));

            sortedSubdistricts.forEach(item => {
                const isMarked = this.markingManager.isMarked(item);
                const subdistrictDiv = document.createElement('div');
                subdistrictDiv.className = 'subdistrict-item';
                subdistrictDiv.innerHTML = `
                    <span class="subdistrict-name" title="${item.name}">${item.name}</span>
                    <button class="mark-btn ${isMarked ? 'marked' : ''}" data-feature-name="${item.name}">
                        ${isMarked ? 'Unmark' : 'Mark'}
                    </button>
                `;

                subdistrictDiv.querySelector('.mark-btn').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const currentlyMarked = this.markingManager.isMarked(item);
                    await this.markingManager.markFeature(item, !currentlyMarked);
                    this.updatePanel();
                });

                subdistrictList.appendChild(subdistrictDiv);
            });

            districtHeader.querySelector('.mark-district-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                const districtCode = e.target.dataset.districtCode;
                const allCurrentlyMarked = district.subdistricts.every(item =>
                    this.markingManager.isMarked(item)
                );

                await this.markingManager.markDistrictByCode(districtCode, !allCurrentlyMarked);
                this.updatePanel();
            });

            const chevron = districtHeader.querySelector('.district-chevron');
            districtHeader.addEventListener('click', (e) => {
                if (!e.target.closest('.district-info')) return;
                if (e.target.closest('.mark-district-btn')) return;
                if (this.expandedDistricts.has(district.code)) {
                    this.expandedDistricts.delete(district.code);
                } else {
                    this.expandedDistricts.add(district.code);
                }
                this.updateFeatureList();
            });

            districtDiv.appendChild(districtHeader);
            districtDiv.appendChild(subdistrictList);
            container.appendChild(districtDiv);
        });
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        this._panel.style.display = 'flex';
        this.isOpen = true;
        this.updatePanel();
    }

    close() {
        this._panel.style.display = 'none';
        this.isOpen = false;
    }
}