const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { workspace, deferred, turn } = require('./helpers/workspace.cjs');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/workspace.js'), 'utf8'), context);
const W = context.window.__OVERLAYABLE__.workspace;
const plain = value => JSON.parse(JSON.stringify(value));
const point = (id, nodeId, coordinates = [126, 37]) => ({ type: 'Feature', id,
  geometry: { type: 'Point', coordinates }, properties: { name: id, data: { preserved: true },
    overlayable: { editorId: id, nodeId } } });
const line = () => ({ type: 'Feature', id: 'line', geometry: { type: 'LineString', coordinates: [[126, 37], [126.001, 37.001], [126.002, 37.002]] },
  properties: { overlayable: { featureId: 'line', segmentEdgeIds: [50, 51], vertexNodeIds: ['a', 'b', 'c'] } } });

test('defaulting preserves explicit locations and independent edge environment/type', () => {
  const location = { buildingNodeId: 10, floor: '4', floorOrder: 4 };
  const explicit = { buildingNodeId: 20, floor: '3', floorOrder: 3 };
  const p = point('a', 1); p.properties.location = explicit;
  const l = line(); l.properties.edgeType = 'STAIR'; l.properties.indoor = false;
  const input = { type: 'FeatureCollection', features: [p, point('b', null), l] };
  const output = W.withDefaults(input, location, false);
  assert.deepEqual(plain(output.features[0].properties.location), explicit);
  assert.deepEqual(plain(output.features[1].properties.location), location);
  assert.equal(output.features[2].properties.edgeType, 'STAIR');
  assert.equal(output.features[2].properties.indoor, false);
  assert.equal(input.features[1].properties.location, undefined);
});

test('external binding preserves other vertices and IDs; unbinding drops the foreign identity', () => {
  const reference = point('remote', 77, [130, 38]); reference.properties.overlayable.ownerLayerId = 2;
  const bound = W.bindEndpoint(line(), 'start', reference);
  assert.deepEqual(plain(bound.geometry.coordinates[0]), [130, 38]);
  assert.deepEqual(plain(bound.properties.overlayable.vertexRefs), [{ nodeId: 77, ownerLayerId: 2 }, { editorId: 'b' }, { editorId: 'c' }]);
  assert.deepEqual(plain(bound.properties.overlayable.segmentEdgeIds), [50, 51]);
  assert.equal(bound.properties.overlayable.vertexNodeIds, undefined);
  const detached = W.bindEndpoint(bound, 'start', null);
  assert.equal(detached.properties.overlayable.vertexRefs[0], null);
  assert.equal(detached.properties.overlayable.vertexRefs[1].editorId, 'b');
});

test('changing the default saves earlier drafts with the old location first', async () => {
  const h = await workspace();
  const next = { buildingNodeId: 20, buildingCode: 'H', buildingName: 'H동', floor: '3', floorOrder: 3 };
  h.state.workspace.layers[0].locations.push(next);
  h.geojson.features.push(point('new-point', null));
  await h.handlers.onDefaultLocation('20:3');
  const save = h.requests.find(r => r.method === 'PUT');
  assert.equal(save.body.protocolVersion, 2);
  assert.equal(save.body.geojson.features.at(-1).properties.location.buildingNodeId, 10);
  assert.equal(h.state.workspace.defaultLocation.buildingNodeId, 20);
  h.geojson.features.push(point('after-switch', null));
  await h.autosync();
  assert.equal(h.requests.filter(r => r.method === 'PUT').at(-1).body.geojson.features.at(-1).properties.location.buildingNodeId, 20);
});

test('a conflict preserves the previous default and local drafts', async () => {
  const h = await workspace();
  h.state.workspace.layers[0].locations.push({ buildingNodeId: 20, floor: '3', floorOrder: 3 });
  h.geojson.features.push(point('draft', null)); h.snapshots.get(1).revision++;
  await h.handlers.onDefaultLocation('20:3');
  assert.equal(h.state.workspace.defaultLocation.buildingNodeId, 10);
  assert.equal(h.geojson.features.at(-1).id, 'draft');
  assert.equal(h.state.workspace.error, true);
});

test('multi-point reclassification preserves node IDs and arbitrary metadata', async () => {
  const h = await workspace();
  h.state.workspace.layers[0].locations.push({ buildingNodeId: 20, floor: '3', floorOrder: 3 });
  h.geojson.features = [point('a', 101), point('b', 102), point('c', 103)];
  h.geojson.features[2].properties.location = { buildingNodeId: 10, floor: '1', floorOrder: 1 };
  h.selectFeatures(['a', 'b']);
  await h.handlers.onClassifySelected('20:3');
  assert.deepEqual(h.geojson.features.map(f => f.properties.overlayable.nodeId), [101, 102, 103]);
  assert.deepEqual(h.geojson.features.map(f => f.properties.location.buildingNodeId), [20, 20, 10]);
  assert.ok(h.geojson.features.every(f => f.properties.data.preserved));
});

test('reference photos and nodes never enter editable graph or owner image payload', async () => {
  const h = await workspace();
  h.snapshots.get(2).geojson.features = [point('remote', 201)];
  await h.handlers.onReferenceAdd(2);
  assert.equal(h.state.workspace.referencePhotos.length, 1);
  assert.equal(h.state.photos.length, 1);
  assert.equal(h.geojson.features.some(f => f.id === 'remote'), false);
  h.handlers.onReferenceOpacity(2, 0.2);
  h.geojson.features[0].properties.name = 'edited';
  await h.autosync();
  const request = h.requests.find(r => r.method === 'PUT');
  assert.deepEqual(request.body.images.map(i => i.id), ['image-1']);
  assert.equal(request.body.geojson.features.some(f => f.id === 'remote'), false);
  assert.equal(h.state.workspace.referencePhotos[0].opacity, 0.2);
});

test('a late reference load cannot attach to another owner after a switch', async () => {
  const h = await workspace(), pending = deferred();
  h.requestHook = (url, opts) => url === '/api/admin/layers/2/snapshot?protocolVersion=2' ? pending.promise : h.defaultRequest(url, opts);
  const load = h.handlers.onReferenceAdd(2);
  await h.select(3);
  pending.resolve({ data: h.snapshots.get(2) }); await load;
  assert.equal(h.state.workspace.layerId, 3);
  assert.equal(h.state.workspace.referenceSnapshots.length, 0);
  assert.equal(h.state.workspace.referencePhotos.length, 0);
});

test('endpoint binding saves explicit refs/revisions without copying the referenced Point', async () => {
  const h = await workspace();
  h.state.workspace.layers[0].kind = 'SHARED_PATHS';
  h.snapshots.get(2).geojson.features = [point('remote', 201)];
  await h.handlers.onReferenceAdd(2);
  h.geojson.features = [line()]; h.selectFeatures(['line']);
  await h.handlers.onEndpointBind('end', 201);
  const save = h.requests.find(r => r.method === 'PUT');
  assert.deepEqual(save.body.referenceRevisions, { 2: 1 });
  assert.equal(save.body.geojson.features.length, 1);
  assert.deepEqual(save.body.geojson.features[0].properties.overlayable.vertexRefs.at(-1), { nodeId: 201, ownerLayerId: 2 });
});

test('empty-image shared workspace loads and defaults nodes to shared ownership', async () => {
  const h = await workspace();
  h.state.workspace.layers[1].kind = 'SHARED_PATHS'; h.snapshots.get(2).images = [];
  await h.select(2);
  assert.equal(h.state.photos.length, 0);
  h.geojson.features.push(point('shared', null)); await h.autosync();
  const save = h.requests.find(r => r.method === 'PUT');
  assert.equal(save.body.geojson.features.at(-1).properties.location.buildingNodeId, null);
  assert.deepEqual(save.body.images, []);
});

test('transfer preview is read-only until execution and selection changes invalidate it', async () => {
  const h = await workspace();
  const preview = { targetLayerId: 3, nodeIds: [101], edgeIds: [201], retainedNodeIds: [102],
    affectedLayerIds: [1, 3], expectedRevisions: { 1: 1, 3: 1 }, previewToken: 'token', nodeCount: 1, edgeCount: 1 };
  h.requestHook = (url, opts) => url === '/api/admin/graph-transfers/preview' ? { data: preview } : h.defaultRequest(url, opts);
  await h.handlers.onTransferPreview({ targetLayerId: 3, nodeIds: [101], edgeIds: [] });
  assert.equal(h.state.workspace.transferPreview.previewToken, 'token');
  assert.equal(h.requests.some(r => r.url === '/api/admin/graph-transfers'), false);
  h.handlers.onTransferSelectionChange();
  assert.equal(h.state.workspace.transferPreview, null);
});

test('transfer execution preserves edits made while the server is moving nodes', async () => {
  const h = await workspace(), pending = deferred();
  const preview = { targetLayerId: 3, nodeIds: [101], edgeIds: [], retainedNodeIds: [], affectedLayerIds: [1, 3],
    expectedRevisions: { 1: 1, 3: 1 }, previewToken: 'token', nodeCount: 1, edgeCount: 0 };
  h.requestHook = (url, opts) => url === '/api/admin/graph-transfers/preview' ? { data: preview }
    : url === '/api/admin/graph-transfers' ? pending.promise : h.defaultRequest(url, opts);
  await h.handlers.onTransferPreview({ targetLayerId: 3, nodeIds: [101], edgeIds: [] });
  const execute = h.handlers.onTransferExecute(); await turn();
  h.geojson.features[0].properties.name = 'edited while transfer running';
  pending.resolve({ data: { ...preview, updatedRevisions: { 1: 2, 3: 2 } } });
  await execute;
  assert.equal(h.geojson.features[0].properties.name, 'edited while transfer running');
  assert.equal(h.state.workspace.error, true);
  assert.match(h.state.workspace.status, /이전은 완료/);
});

test('incoming-edge owner revisions survive a local-only snapshot save', async () => {
  const h = await workspace();
  h.state.workspace.referenceRevisions = { 3: 7 };
  h.geojson.features[0].properties.name = 'move affected node';
  await h.autosync();
  assert.deepEqual(h.requests.find(r => r.method === 'PUT').body.referenceRevisions, { 3: 7 });
});

test('reference graphs include readonly paths while candidate Points preserve their owner', () => {
  const collection = W.referenceCollection([{ layerId: 2, geojson: { features: [point('a', 20), line()] } }]);
  assert.equal(collection.features.filter(f => f.geometry.type === 'LineString').length, 1);
  assert.equal(collection.features.find(f => f.geometry.type === 'LineString').properties.overlayable.kind, 'edge-reference');
  assert.equal(collection.features.find(f => f.geometry.type === 'Point').properties.overlayable.ownerLayerId, 2);
});

test('moving a pinned foreign endpoint stops before a write and keeps the draft', async () => {
  const h = await workspace();
  const reference = point('remote', 201); reference.properties.overlayable.ownerLayerId = 2;
  h.state.workspace.referenceFeatures = [reference];
  const feature = W.bindEndpoint(line(), 'start', reference);
  feature.geometry.coordinates[0] = [127, 38];
  h.geojson.features = [plain(feature)];
  await h.autosync();
  assert.equal(h.requests.some(r => r.method === 'PUT'), false);
  assert.match(h.state.workspace.status, /외부 연결점 Node #201/);
  assert.deepEqual(h.geojson.features[0].geometry.coordinates[0], [127, 38]);
});

test('layer selection cannot race a default change while its draft is saving', async () => {
  const h = await workspace(), pending = deferred();
  h.state.workspace.layers[0].locations.push({ buildingNodeId: 20, floor: '3', floorOrder: 3 });
  h.geojson.features[0].properties.name = 'dirty';
  h.requestHook = async (url, opts) => { if (opts.method === 'PUT') await pending.promise; return h.defaultRequest(url, opts); };
  const changing = h.handlers.onDefaultLocation('20:3'); await turn();
  assert.equal(h.layerSelect.disabled, true);
  await h.select(3);
  assert.equal(h.state.workspace.layerId, 1);
  pending.resolve(); await changing;
  assert.equal(h.state.workspace.defaultLocation.buildingNodeId, 20);
  assert.equal(h.requests.some(r => r.url.includes('/layers/3/')), false);
});

test('floor connection creates a v2 owned MANUAL line without calling the legacy endpoint', async () => {
  const h = await workspace();
  const first = point('first', 101), second = point('second', 201, [126, 37.001]);
  h.geojson.features = [first]; h.selectFeatures(['first']);
  await h.handlers.onVerticalConnect();
  assert.equal(h.state.workspace.connectionDraft.sourceNodeId, 101);
  h.snapshots.get(2).geojson.features = [second];
  await h.select(2); h.selectFeatures(['second']);
  h.promptAnswers = ['STAIR', '4.5'];
  await h.handlers.onVerticalConnect();
  const saved = h.geojson.features.find(f => f.geometry.type === 'LineString');
  assert.equal(saved.properties.weightMode, 'MANUAL');
  assert.deepEqual(saved.properties.weights, [4.5]);
  assert.deepEqual(saved.properties.overlayable.vertexRefs, [{ nodeId: 101, ownerLayerId: 1 }, { editorId: 'second' }]);
  assert.equal(h.requests.some(r => r.url.includes('vertical-connections')), false);
  assert.equal(h.state.workspace.connectionDraft, null);
});

test('shared workspaces block upload and local image import without poisoning switching', async () => {
  const h = await workspace();
  h.state.workspace.layers[1].kind = 'SHARED_PATHS'; h.snapshots.get(2).images = [];
  await h.select(2); h.requests.length = 0;
  h.handlers.onUpload({ name: 'must-not-upload.png', type: 'image/png' });
  h.handlers.onImport('{"photos":[]}');
  assert.equal(h.state.photos.length, 0);
  assert.equal(h.requests.length, 0);
  const fileInputs = h.elements.filter(el => el.tagName === 'input' && el.getAttribute('type') === 'file');
  assert.ok(fileInputs.length > 0 && fileInputs.every(el => el.disabled));
  await h.select(1);
  assert.equal(h.state.workspace.layerId, 1);
  assert.equal(h.state.workspace.error, false);
});

test('selecting shared with existing local images never prompts or uploads legacy photos', async () => {
  const h = await workspace();
  h.state.workspace.layerId = null;
  h.state.photos = [{ id: 'legacy', name: 'legacy.png', src: 'data:image/png;base64,aGVsbG8=' }];
  h.state.workspace.layers[1].kind = 'SHARED_PATHS'; h.snapshots.get(2).images = [];
  await h.select(2);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
  assert.equal(h.state.workspace.layerId, 2);
  assert.equal(h.state.workspace.error, false);
});

test('a default-only change is persisted once without needing a graph edit', async () => {
  const h = await workspace();
  h.state.workspace.layers[0].locations.push({ buildingNodeId: 20, floor: '3', floorOrder: 3 });
  await h.handlers.onDefaultLocation('20:3');
  const writes = h.requests.filter(r => r.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.defaultLocation, { buildingNodeId: 20, floor: '3', floorOrder: 3 });
  assert.equal(h.snapshots.get(1).defaultLocation.buildingNodeId, 20);
  await h.autosync();
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
});

test('same-revision dependency changes are applied without stale candidate overrides', async () => {
  const h = await workspace();
  const reference = point('remote', 201); reference.properties.overlayable.ownerLayerId = 2;
  h.snapshots.get(2).geojson.features = [reference]; await h.handlers.onReferenceAdd(2);
  h.snapshots.get(1).referenceRevisions = { 2: 3, 3: 8 };
  h.snapshots.get(1).references = [{ ...reference, geometry: { type: 'Point', coordinates: [126.01, 37] } }];
  await h.autosync();
  assert.equal(h.state.workspace.revision, 1);
  assert.deepEqual(plain(h.state.workspace.referenceRevisions), { 2: 3, 3: 8 });
  assert.deepEqual(plain(h.state.workspace.referenceFeatures.find(f => f.properties.overlayable.nodeId === 201).geometry.coordinates), [126.01, 37]);
});

test('dependency polling preserves edits made while its response is in flight', async () => {
  const h = await workspace(), pending = deferred();
  h.snapshots.get(1).referenceRevisions = { 3: 8 };
  h.requestHook = (url, opts) => opts.method ? h.defaultRequest(url, opts) : pending.promise;
  const poll = h.autosync(); await turn();
  h.geojson.features[0].properties.name = 'edit during dependency refresh';
  pending.resolve({ data: structuredClone(h.snapshots.get(1)) }); await poll;
  assert.equal(h.geojson.features[0].properties.name, 'edit during dependency refresh');
  assert.deepEqual(plain(h.state.workspace.referenceRevisions), {});
});

test('snapshot location/default metadata refreshes the permitted UI choices', async () => {
  const h = await workspace();
  const location = { buildingNodeId: 20, buildingCode: 'H', buildingName: 'H동', floor: '3', floorOrder: 3 };
  Object.assign(h.snapshots.get(1), { revision: 2, locations: [location], defaultLocation: location });
  await h.autosync();
  assert.deepEqual(plain(h.state.workspace.layers[0].locations), [location]);
  assert.equal(h.state.workspace.defaultLocation.buildingNodeId, 20);
});

test('omitted persisted node location and edge mode remain omitted for backend preservation', () => {
  const p = point('saved', 101), l = line();
  const normalized = W.withDefaults({ type: 'FeatureCollection', features: [p, l] }, { buildingNodeId: 20, floor: '3', floorOrder: 3 }, false);
  assert.equal(normalized.features[0].properties.location, undefined);
  assert.equal(normalized.features[1].properties.weightMode, undefined);
});

test('same-drawing G to H endpoint binding reuses the local UUID without cloning', async () => {
  const h = await workspace();
  const g = point('g-point', 101), hh = point('h-point', 102, [126.01, 37]);
  g.properties.location = { buildingNodeId: 10, floor: '4', floorOrder: 4 };
  hh.properties.location = { buildingNodeId: 20, floor: '1', floorOrder: 1 };
  h.state.workspace.layers[0].locations.push(hh.properties.location);
  h.geojson.features = [g, hh, line()]; h.selectFeatures(['line']);
  await h.handlers.onEndpointBind('end', 102);
  const saved = h.requests.find(r => r.method === 'PUT').body.geojson;
  assert.equal(saved.features.filter(f => f.geometry.type === 'Point').length, 2);
  assert.deepEqual(saved.features.find(f => f.geometry.type === 'LineString').properties.overlayable.vertexRefs.at(-1), { editorId: 'h-point' });
  assert.deepEqual(saved.features.find(f => f.geometry.type === 'LineString').geometry.coordinates.at(-1), hh.geometry.coordinates);
  assert.equal(h.state.workspace.referenceFeatures.length, 0);
});

test('single-location layers requiring protocol v2 cannot use ambiguous copy', async () => {
  const h = await workspace();
  h.state.workspace.layers[0].requiresProtocolV2 = true; h.pollPanel();
  assert.equal(h.elements.find(el => el.tagName === 'button' && el.textContent === '복사').disabled, true);
});

test('ownership summary stays outside collapsed details and labels shared nodes as having no floor', async () => {
  const h = await workspace();
  const first = point('g', 101), second = point('h', 102);
  first.properties.location = { buildingNodeId: 10, floor: '1', floorOrder: 1 };
  second.properties.location = { buildingNodeId: 20, floor: '3', floorOrder: 3 };
  h.state.workspace.layers[0].locations.push({ ...second.properties.location, buildingName: 'H동' });
  h.geojson.features = [first, second]; h.selectFeatures(['g', 'h']); h.pollPanel();
  const summary = h.elements.find(el => el.className.includes('imgovl-ownership-summary'));
  assert.equal(summary.parentElement.tagName, 'section');
  assert.match(summary.textContent, /선택 Point 2개/);
  assert.match(summary.textContent, /C동 1층/);
  assert.match(summary.textContent, /H동 3층/);
  first.properties.location = { buildingNodeId: null, floor: '0', floorOrder: 0 };
  h.selectFeatures(['g']); h.pollPanel();
  assert.match(summary.textContent, /공용 경로 · 층 없음/);
});

test('shared location settings never render the internal no-floor sentinel as a removable building', async () => {
  const h = await workspace();
  h.state.workspace.layers[1].kind = 'SHARED_PATHS'; h.snapshots.get(2).images = [];
  await h.select(2);
  const text = node => [node.textContent, ...node.children.map(text)].join(' ');
  const rendered = text(h.panel.panel);
  assert.match(rendered, /공용 경로 · 층 없음/);
  assert.doesNotMatch(rendered, /undefined 0층|목록에서 제거/);
  for (const title of ['허용 소속 추가', '허용 소속 저장']) {
    assert.equal(h.elements.find(el => el.tagName === 'button' && el.textContent === title).disabled, true);
  }
});

test('legacy snapshots cannot replace the current graph or load reference endpoints', async () => {
  const h = await workspace();
  delete h.snapshots.get(2).protocolVersion;
  const before = structuredClone(h.geojson);
  await h.select(2);
  assert.equal(h.state.workspace.layerId, 1);
  assert.deepEqual(h.geojson, before);
  assert.match(h.state.workspace.status, /백엔드 업데이트 필요\(편집 프로토콜 v2\)/);
  await h.handlers.onReferenceAdd(2);
  assert.equal(h.state.workspace.referenceSnapshots.length, 0);
  assert.deepEqual(h.geojson, before);
  assert.equal(h.requests.some(request => request.url === '/images/2' || request.method), false);
});

test('same-revision polling and floor-connection sources explicitly reject a legacy backend', async () => {
  const h = await workspace();
  delete h.snapshots.get(1).protocolVersion;
  await h.autosync();
  assert.match(h.state.workspace.status, /백엔드 업데이트 필요/);
  h.state.workspace.connectionDraft = { sourceNodeId: 101, sourceLayerId: 2 };
  h.geojson.features = [point('destination', 102)];
  h.selectFeatures(['destination']);
  h.snapshots.get(1).protocolVersion = 2;
  delete h.snapshots.get(2).protocolVersion;
  await h.handlers.onVerticalConnect();
  assert.match(h.state.workspace.status, /백엔드 업데이트 필요/);
  assert.equal(h.geojson.features.some(feature => feature.geometry.type === 'LineString'), false);
});
