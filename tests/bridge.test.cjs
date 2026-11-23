const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('discovers separate persistence/data fibers and reads live selection and coordinates', () => {
  let listener;
  const messages = [];
  let data = { featureMap: new Map(), selection: { type: 'none' } };
  const atom = { read() {} };
  const store = { get: () => data };
  const persistence = { idMap: {}, useTransact: () => async () => {} };
  const fiber = { memoizedProps: { value: persistence }, child: {
    memoizedState: { memoizedState: [data, store, atom] }
  } };
  const host = { __reactFiber$test: fiber };
  const window = { postMessage: (m) => messages.push(m), addEventListener: (_, cb) => { listener = cb; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/bridge.js'), 'utf8'), {
    window, Map, Set, console: { info() {}, warn() {} },
    document: { querySelectorAll: () => [host] },
    location: { origin: 'https://geojson.io' }, setInterval() {}, clearInterval() {},
  });
  const read = () => {
    listener({ source: window, data: { source: 'overlayable-content', type: 'geojson-read', requestId: 'test' } });
    return messages.at(-1);
  };
  assert.equal(read().ready, true);
  const feature = { type: 'Feature', id: 'point', geometry: { type: 'Point', coordinates: [1, 2] } };
  data = { featureMap: new Map([['point', { feature }]]), selection: { type: 'single', id: 'point' } };
  assert.equal(read().selectedFeature, feature);
  data = { featureMap: new Map([['point', { feature: { ...feature, geometry: { type: 'Point', coordinates: [3, 4] } } }]]), selection: { type: 'none' } };
  assert.equal(read().selectedFeature, null);
  assert.deepEqual(read().geojson.features[0].geometry.coordinates, [3, 4]);
});

function editableBridge() {
  const { webcrypto } = require('node:crypto');
  const callbacks = new Map(), sources = new Map(), layers = new Map(), messages = [];
  let listener;
  let data = { featureMap: new Map(), selection: { type: 'none' } };
  const atom = { read() {} }, store = { get: () => data };
  const persistence = { idMap: {}, useTransact: () => async (transaction) => {
    for (const id of transaction.deleteFeatures) data.featureMap.delete(id);
    for (const wrapped of transaction.putFeatures) data.featureMap.set(wrapped.id, wrapped);
  } };
  const host = { __reactFiber$test: { memoizedProps: { value: persistence }, child: { memoizedState: { memoizedState: [data, store, atom] } } } };
  const map = {
    getCenter: () => ({ lng: 126, lat: 37 }), getZoom: () => 18, getBearing: () => 0,
    project: () => ({ x: 500, y: 400 }), getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) }),
    on: (event, fn) => callbacks.set(event, fn), off: (event) => callbacks.delete(event),
    getSource: (id) => sources.get(id), addSource: (id, source) => sources.set(id, { ...source, setData(next) { this.data = next; } }),
    removeSource: (id) => sources.delete(id), getLayer: (id) => layers.get(id), addLayer: (layer) => layers.set(layer.id, layer), removeLayer: (id) => layers.delete(id),
  };
  const window = { api: { map }, postMessage: (message) => messages.push(message), addEventListener: (_, fn) => { listener = fn; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/bridge.js'), 'utf8'), {
    window, Map, Set, crypto: webcrypto, console: { info() {}, warn() {} },
    document: { querySelectorAll: () => [host] }, location: { origin: 'https://geojson.io' },
    setInterval() {}, clearInterval() {}, setTimeout: (fn) => queueMicrotask(fn),
  });
  return { sources, layers, callbacks, messages, data, map, async send(type, payload = {}) {
    listener({ source: window, data: { source: 'overlayable-content', type, requestId: 'test', ...payload } });
    await new Promise(setImmediate);
    return messages.at(-1);
  } };
}

test('reference map source stays outside editor persistence and survives map style reload', async () => {
  const h = editableBridge();
  const owned = { type: 'Feature', id: 'owned', geometry: { type: 'Point', coordinates: [1, 2] } };
  h.data.featureMap.set('owned', { id: 'owned', feature: owned });
  const references = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'ref', geometry: { type: 'Point', coordinates: [3, 4] } }] };
  await h.send('references-set', { geojson: references });
  assert.equal(h.sources.size, 1); assert.equal(h.layers.size, 2);
  const read = await h.send('geojson-read');
  assert.deepEqual(JSON.parse(JSON.stringify(read.geojson.features)), [owned]);
  h.sources.clear(); h.layers.clear(); h.callbacks.get('style.load')();
  assert.equal(h.sources.size, 1); assert.equal(h.layers.size, 2);
  await h.send('references-set', { geojson: { type: 'FeatureCollection', features: [] } });
  assert.equal(h.sources.size, 0); assert.equal(h.layers.size, 0);
});

test('mark annotations use live projection and viewport offsets without entering editor data', async () => {
  const h = editableBridge();
  const owned = { type: 'Feature', id: 'owned', geometry: { type: 'Point', coordinates: [1, 2] } };
  h.data.featureMap.set('owned', { id: 'owned', feature: owned });
  h.map.getContainer = () => ({ getBoundingClientRect: () => ({ left: 20, top: 30, width: 1000, height: 800 }) });
  h.map.getBearing = () => 45;
  h.map.getPitch = () => 30;
  let shift = 0;
  h.map.project = (coordinate) => Array.isArray(coordinate)
    ? { x: coordinate[0] * 10 + shift, y: coordinate[1] * 20 - shift } : { x: 500, y: 400 };
  const annotations = { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'node', properties: { overlayableMark: 'A' }, geometry: { type: 'Point', coordinates: [1, 2] } },
    { type: 'Feature', id: 'edge', properties: { overlayableMark: 'G' }, geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4], [5, 6]] } },
  ] };
  const camera = await h.send('marks-set', { geojson: annotations });
  assert.equal(camera.type, 'camera');
  assert.equal(camera.pitch, 30);
  assert.equal(camera.bearing, 45);
  assert.deepEqual(JSON.parse(JSON.stringify(camera.marks)), [
    { id: 'node', code: 'A', type: 'Point', points: [{ x: 30, y: 70 }] },
    { id: 'edge', code: 'G', type: 'LineString', points: [{ x: 30, y: 70 }, { x: 50, y: 110 }, { x: 70, y: 150 }] },
  ]);
  shift = 100;
  h.callbacks.get('move')();
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1).marks[0].points)), [{ x: 130, y: -30 }]);
  h.map.getContainer = () => ({ getBoundingClientRect: () => ({ left: 50, top: 60, width: 800, height: 600 }) });
  h.callbacks.get('resize')();
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1).marks[0].points)), [{ x: 160, y: 0 }]);
  const read = await h.send('geojson-read');
  assert.deepEqual(JSON.parse(JSON.stringify(read.geojson.features)), [owned]);
  assert.equal(h.sources.size, 0);
  const cleared = await h.send('marks-set', { geojson: { type: 'FeatureCollection', features: [] } });
  assert.equal(cleared.marks.length, 0);
});

test('malformed markings and failed projections cannot break camera updates', async () => {
  const h = editableBridge();
  const mark = (code, type, coordinates, id = code) => ({ type: 'Feature', id, properties: { overlayableMark: code }, geometry: { type, coordinates } });
  h.map.project = (coordinate) => {
    if (!Array.isArray(coordinate)) return { x: 500, y: 400 };
    if (coordinate[0] === 7) throw new Error('projection failed');
    if (coordinate[0] === 8) return { x: Infinity, y: 1 };
    return { x: coordinate[0], y: coordinate[1] };
  };
  const camera = await h.send('marks-set', { geojson: { type: 'FeatureCollection', features: [
    null, {}, mark('Z', 'Point', [1, 2]), mark('AA', 'Point', [1, 2]), mark('a', 'Point', [1, 2]),
    mark('A', 'Polygon', [[[1, 2], [3, 4]]]), mark('A', 'Point', ['1', 2]), mark('A', 'Point', [1, NaN]),
    mark('A', 'Point', [181, 2]), mark('A', 'Point', [1, 91]), mark('A', 'Point', []),
    mark('B', 'LineString', [[1, 2]]), mark('B', 'LineString', [[1, 2], null]),
    mark('C', 'Point', [7, 2]), mark('D', 'Point', [8, 2]), mark('E', 'Point', [3, 4]),
  ] } });
  assert.equal(camera.type, 'camera');
  assert.deepEqual(JSON.parse(JSON.stringify(camera.marks)), [{ id: 'E', code: 'E', type: 'Point', points: [{ x: 3, y: 4 }] }]);
  const cleared = await h.send('marks-set', { geojson: null });
  assert.equal(cleared.marks.length, 0);
});

test('bridge exposes every selected Point and applies one metadata-preserving transaction', async () => {
  const h = editableBridge();
  const point = id => ({ type: 'Feature', id, properties: { overlayable: { editorId: id, nodeId: id === 'a' ? 1 : 2 } }, geometry: { type: 'Point', coordinates: [1, 2] } });
  h.data.featureMap.set('a', { id: 'a', folderId: 'folder', feature: point('a') });
  h.data.featureMap.set('b', { id: 'b', folderId: 'folder', feature: point('b') });
  h.data.selection = { type: 'multi', ids: ['a', 'b'] };
  const read = await h.send('geojson-read');
  assert.equal(read.selectedFeatures.length, 2);
  const features = read.selectedFeatures.map(feature => ({ ...feature, properties: { ...feature.properties, location: { buildingNodeId: 2, floor: '4', floorOrder: 4 } } }));
  await h.send('geojson-update', { features });
  assert.equal(h.data.featureMap.get('a').folderId, 'folder');
  assert.equal(h.data.featureMap.get('a').feature.properties.overlayable.nodeId, 1);
  assert.equal(h.data.featureMap.get('b').feature.properties.location.floor, '4');
  const ambiguous = await h.send('geojson-patch-selected', { properties: { name: 'must not apply to the first point' } });
  assert.equal(ambiguous.type, 'geojson-error');
  assert.equal(h.data.featureMap.get('a').feature.properties.name, undefined);
});

test('unsaved feature selections use wrapper IDs for bulk classification and endpoint updates', async () => {
  const h = editableBridge();
  const fresh = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } };
  h.data.featureMap.set('wrapper-a', { id: 'wrapper-a', feature: fresh });
  h.data.featureMap.set('wrapper-b', { id: 'wrapper-b', feature: { ...fresh, geometry: { type: 'Point', coordinates: [3, 4] } } });
  h.data.selection = { type: 'multi', ids: ['wrapper-a', 'wrapper-b'] };
  const read = await h.send('geojson-read');
  assert.deepEqual(JSON.parse(JSON.stringify(read.selectedFeatures.map(f => f.id))), ['wrapper-a', 'wrapper-b']);
  await h.send('geojson-update', { features: read.selectedFeatures.map(f => ({ ...f, properties: { location: { buildingNodeId: 20, floor: '3', floorOrder: 3 } } })) });
  assert.equal(h.data.featureMap.size, 2);
  assert.equal(h.data.featureMap.get('wrapper-b').feature.properties.location.buildingNodeId, 20);
  const freshLine = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } };
  h.data.featureMap.set('wrapper-line', { id: 'wrapper-line', feature: freshLine });
  h.data.selection = { type: 'single', id: 'wrapper-line' };
  const selection = (await h.send('geojson-read')).selectedFeature;
  await h.send('geojson-update', { features: [{ ...selection, properties: { overlayable: { vertexRefs: [null, { nodeId: 20, ownerLayerId: 2 }] } } }] });
  assert.equal(h.data.featureMap.get('wrapper-line').feature.properties.overlayable.vertexRefs[1].nodeId, 20);
});

test('update resolves a feature ID that differs from its persistence wrapper ID', async () => {
  const h = editableBridge();
  h.data.featureMap.set('wrapper', { id: 'wrapper', feature: { type: 'Feature', id: 'feature-id', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } } });
  h.data.selection = { type: 'single', id: 'wrapper' };
  const selected = (await h.send('geojson-read')).selectedFeature;
  await h.send('geojson-update', { features: [{ ...selected, properties: { name: 'updated' } }] });
  assert.equal(h.data.featureMap.size, 1);
  assert.equal(h.data.featureMap.get('wrapper').feature.properties.name, 'updated');
});
