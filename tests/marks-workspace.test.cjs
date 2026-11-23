const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspace } = require('./helpers/workspace.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const location = { buildingNodeId: 10, floor: '1', floorOrder: 1 };
function point(id, nodeId, coordinates = [126, 37]) {
  return { type: 'Feature', id, geometry: { type: 'Point', coordinates }, properties: {
    name: id, nodeType: 'WAYPOINT', searchable: false, roomNumber: null, location,
    data: { preserved: { text: '기존 메타데이터', values: [1, 2] } },
    overlayable: { kind: 'node', editorId: id, nodeId },
  } };
}
function fixtures() {
  return [point('a', 101), point('b', 102, [126.001, 37]), {
    type: 'Feature', id: 'line',
    geometry: { type: 'LineString', coordinates: [[126, 37], [126.001, 37]] },
    properties: { edgeType: 'STAIR', indoor: false, bidirectional: false,
      weightMode: 'MANUAL', weights: [7.25], data: { preserved: { source: 'survey' } },
      overlayable: { kind: 'edge-chain', featureId: 'line', segmentEdgeIds: [501],
        vertexNodeIds: ['a', 'b'], vertexRefs: [{ editorId: 'a' }, { editorId: 'b' }] } },
  }];
}

// The real server rebuilds canonical features rather than echoing style fields.
// Keep only fields emitted by LayerWorkspaceService.pointFeature/lineFeature.
function canonicalFeature(feature) {
  const node = feature.geometry.type === 'Point';
  const keys = node ? ['name', 'nodeType', 'searchable', 'roomNumber', 'location', 'data']
    : ['edgeType', 'indoor', 'bidirectional', 'weightMode', 'weights', 'data'];
  const metaKeys = node ? ['kind', 'editorId', 'nodeId']
    : ['kind', 'featureId', 'vertexRefs', 'vertexNodeIds', 'segmentEdgeIds'];
  const properties = Object.fromEntries(keys.filter(key => key in feature.properties)
    .map(key => [key, structuredClone(feature.properties[key])]));
  properties.overlayable = Object.fromEntries(metaKeys.filter(key => key in feature.properties.overlayable)
    .map(key => [key, structuredClone(feature.properties.overlayable[key])]));
  return { type: 'Feature', id: feature.id, geometry: structuredClone(feature.geometry), properties };
}

test('marking mixed nodes and edges preserves geometry, identities, references, costs, and unrelated data', async () => {
  const h = await workspace();
  h.geojson.features = fixtures();
  const before = structuredClone(h.geojson.features);
  h.selectFeatures(['a', 'line']);
  await h.handlers.onMarkSelected('A');
  const saved = h.requests.find(request => request.method === 'PUT').body.geojson.features;
  assert.deepEqual(saved.map(feature => feature.properties.data.overlayableMark), ['A', undefined, 'A']);
  for (let i = 0; i < saved.length; i++) {
    assert.equal(saved[i].id, before[i].id);
    assert.deepEqual(saved[i].geometry, before[i].geometry);
    assert.deepEqual(saved[i].properties.overlayable, before[i].properties.overlayable);
    assert.deepEqual(saved[i].properties.data.preserved, before[i].properties.data.preserved);
  }
  assert.equal(saved[2].properties.weightMode, 'MANUAL');
  assert.deepEqual(saved[2].properties.weights, [7.25]);
  assert.equal(saved[2].properties.edgeType, 'STAIR');
  assert.equal(saved[2].properties.indoor, false);
  assert.equal(saved[2].properties.bidirectional, false);
  assert.equal(h.state.workspace.error, false);
});

test('replacement and removal change only the selected annotation key', async () => {
  const h = await workspace();
  h.geojson.features = fixtures();
  h.geojson.features[0].properties.data.overlayableMark = 'A';
  h.geojson.features[2].properties.data.overlayableMark = 'C';
  h.selectFeatures(['a', 'line']);
  await h.handlers.onMarkSelected('G');
  assert.deepEqual(h.geojson.features.map(feature => feature.properties.data.overlayableMark), ['G', undefined, 'G']);
  h.selectFeatures(['a']);
  await h.handlers.onMarkSelected(null);
  assert.equal(Object.hasOwn(h.geojson.features[0].properties.data, 'overlayableMark'), false);
  assert.deepEqual(h.geojson.features[0].properties.data, fixtures()[0].properties.data);
  assert.equal(h.geojson.features[2].properties.data.overlayableMark, 'G');
  assert.equal(h.snapshots.get(1).geojson.features[0].properties.data.overlayableMark, undefined);
});

test('marks survive canonical server responses, JSON export, and switching away and back', async () => {
  const h = await workspace();
  h.geojson.features = fixtures();
  h.requestHook = async (url, options) => {
    const response = await h.defaultRequest(url, options);
    if (options.method === 'PUT' && url.includes('/snapshot?')) {
      const saved = h.snapshots.get(1);
      saved.geojson.features = saved.geojson.features.map(canonicalFeature);
      return { data: structuredClone(saved) };
    }
    return response;
  };
  h.selectFeatures(['a', 'line']);
  await h.handlers.onMarkSelected('D');
  assert.deepEqual(h.geojson.features.map(feature => feature.properties.data.overlayableMark), ['D', undefined, 'D']);
  assert.equal(h.geojson.features[2].properties.location, undefined);
  const exported = JSON.parse(JSON.stringify(h.geojson));
  assert.equal(exported.features[0].properties.data.overlayableMark, 'D');
  assert.equal(exported.features[2].properties.data.overlayableMark, 'D');
  await h.select(2);
  await h.select(1);
  assert.deepEqual(h.geojson.features.map(feature => feature.properties.data.overlayableMark), ['D', undefined, 'D']);
  assert.deepEqual(h.geojson.features[2].properties.overlayable.segmentEdgeIds, [501]);
  assert.deepEqual(h.geojson.features[2].properties.weights, [7.25]);
});

test('mark action reads current selection instead of stale panel selection', async () => {
  const h = await workspace();
  h.geojson.features = fixtures();
  h.selectFeatures(['a']);
  h.selectedIds = ['line']; // No panel poll between the editor change and the click.
  await h.handlers.onMarkSelected('B');
  assert.equal(h.geojson.features[0].properties.data.overlayableMark, undefined);
  assert.equal(h.geojson.features[2].properties.data.overlayableMark, 'B');
});

test('invalid mark codes fail before mutating or saving selected features', async () => {
  const h = await workspace();
  h.geojson.features = fixtures();
  h.selectFeatures(['a', 'line']);
  const before = structuredClone(h.geojson);
  await h.handlers.onMarkSelected('H');
  assert.deepEqual(h.geojson, before);
  assert.equal(h.requests.some(request => request.method === 'PUT'), false);
  assert.equal(h.state.workspace.error, true);
});

test('unsupported geometries and read-only references cannot be marked', async () => {
  const h = await workspace();
  const polygon = { type: 'Feature', id: 'polygon', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] } };
  const reference = point('reference', 201);
  reference.properties.overlayable = { ...reference.properties.overlayable, kind: 'node-reference', ownerLayerId: 2 };
  const lineReference = fixtures()[2];
  lineReference.properties.overlayable.kind = 'edge-reference';
  lineReference.properties.overlayable.ownerLayerId = 2;
  for (const feature of [polygon, reference, lineReference]) {
    assert.equal(h.marksModule.isMarkable(feature), false);
    assert.throws(() => h.marksModule.withMark(feature, 'A'));
  }
  h.geojson.features = [polygon];
  h.selectFeatures(['polygon']);
  const before = structuredClone(h.geojson);
  await h.handlers.onMarkSelected('A');
  assert.deepEqual(h.geojson, before);
  assert.equal(h.requests.some(request => request.method === 'PUT'), false);
  assert.equal(h.state.workspace.error, true);
});

test('save conflict retains the local mark draft and does not overwrite remote data', async () => {
  const h = await workspace();
  h.geojson.features = fixtures();
  h.selectFeatures(['a', 'line']);
  h.snapshots.get(1).revision++;
  const remoteBefore = structuredClone(h.snapshots.get(1));
  await h.handlers.onMarkSelected('F');
  assert.equal(h.state.workspace.error, true);
  assert.deepEqual(h.snapshots.get(1), remoteBefore);
  assert.deepEqual(h.geojson.features.map(feature => feature.properties.data.overlayableMark), ['F', undefined, 'F']);
  assert.equal(h.requests.filter(request => request.method === 'PUT').length, 1);
});

test('mark helper accepts all seven codes without mutating source or manufacturing IDs', async () => {
  const h = await workspace();
  const source = fixtures()[0];
  const before = structuredClone(source);
  for (const code of 'ABCDEFG') {
    const marked = h.marksModule.withMark(source, code);
    assert.equal(h.marksModule.getMark(marked), code);
    assert.equal(marked.id, source.id);
    assert.deepEqual(plain(marked.geometry), source.geometry);
    assert.deepEqual(plain(marked.properties.data.preserved), source.properties.data.preserved);
  }
  assert.deepEqual(source, before);
});
