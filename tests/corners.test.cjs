const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspace, turn, deferred } = require('./helpers/workspace.cjs');
const plain = (value) => JSON.parse(JSON.stringify(value));
function draft(h) {
  h.handlers.onCornerImage();
  h.handlers.onCornerCoordinate(0, 126.9, 37.5);
  h.handlers.onCornerCoordinate(1, 126.91, 37.51);
}

test('two ordered reference points save after graph edits using the latest revision without graph/transform changes', async () => {
  const h = await workspace();
  const transform = plain(h.state.photos[0]);
  draft(h);
  h.geojson.features[0].properties.name = 'graph edit';
  await h.handlers.onCornerSave();
  const writes = h.requests.filter((request) => request.method);
  assert.deepEqual(writes.map((request) => request.method), ['PUT', 'POST']);
  assert.equal(writes[1].url, '/api/admin/layers/1/floor-plan-corners');
  assert.equal(writes[1].body.expectedRevision, 2);
  assert.deepEqual(writes[1].body.points, [{ longitude: 126.9, latitude: 37.5 }, { longitude: 126.91, latitude: 37.51 }]);
  assert.equal(h.state.workspace.revision, 3);
  assert.equal(h.state.workspace.corners.dirty, false);
  assert.equal(h.geojson.features.length, 1);
  assert.equal(h.geojson.features[0].properties.name, 'graph edit');
  assert.deepEqual(plain(h.state.photos[0]), transform);
  await h.select(2); await h.select(1);
  assert.deepEqual(plain(h.state.workspace.corners.points), writes[1].body.points);
});

test('incomplete, out-of-range, and duplicate points never write and prevent leaving the layer', async () => {
  const h = await workspace();
  h.handlers.onCornerImage(); h.handlers.onCornerCoordinate(0, 126.9, 37.5);
  await h.select(2);
  assert.equal(h.state.workspace.layerId, 1);
  assert.match(h.status.textContent, /기준점 1과 2/);
  h.handlers.onCornerCoordinate(1, 181, 37.5);
  await h.handlers.onCornerSave();
  assert.match(h.state.workspace.corners.error, /경도/);
  h.handlers.onCornerCoordinate(1, 126.9, 37.5);
  await h.handlers.onCornerSave();
  assert.match(h.state.workspace.corners.error, /서로 다른/);
  h.handlers.onCornerCoordinate(1, '', 37.5);
  await h.autosync();
  assert.equal(h.requests.filter((request) => request.method).length, 0);
  h.handlers.onCornerDiscard(); await h.select(2);
  assert.equal(h.state.workspace.layerId, 2);
});

test('corner conflicts and network failures keep both draft and graph revisions until explicit reload', async () => {
  const h = await workspace(); draft(h);
  h.snapshots.get(1).revision = 2;
  h.snapshots.get(1).geojson.features[0].properties.name = 'remote graph';
  await h.handlers.onCornerSave();
  assert.equal(h.state.workspace.revision, 1);
  assert.equal(h.state.workspace.corners.dirty, true);
  assert.match(h.state.workspace.corners.error, /충돌/);
  assert.equal(h.geojson.features[0].properties.name, 'floor-1');
  await h.select(2); assert.equal(h.state.workspace.layerId, 1);
  await h.handlers.onLayerReload();
  assert.equal(h.state.workspace.revision, 2);
  assert.equal(h.state.workspace.corners.dirty, false);
  assert.equal(h.geojson.features[0].properties.name, 'remote graph');
  draft(h);
  h.requestHook = (url, options) => options.method === 'POST' ? Promise.reject(new Error('network down')) : h.defaultRequest(url, options);
  await h.handlers.onCornerSave();
  assert.equal(h.state.workspace.corners.dirty, true);
  assert.match(h.state.workspace.corners.error, /network down/);
});

test('a separate corner read never advances the snapshot revision or applies mismatched remote data', async () => {
  const h = await workspace();
  h.requestHook = (url, options) => url === '/api/layers/2/floor-plan-corners'
    ? Promise.resolve({ data: { layerId: 2, revision: 2, imageId: null, points: [] } }) : h.defaultRequest(url, options);
  await h.select(2);
  assert.equal(h.state.workspace.layerId, 1);
  assert.equal(h.state.workspace.revision, 1);
  assert.equal(h.replacements.length, 0);
  assert.match(h.status.textContent, /충돌/);
});

test('edits started during a remote corner read survive and cannot overwrite a newer remote pair', async () => {
  const h = await workspace(), pending = deferred();
  h.snapshots.get(1).revision = 2;
  h.corners.set(1, { imageId: 'image-1', points: [{ longitude: 1, latitude: 2 }, { longitude: 3, latitude: 4 }] });
  h.requestHook = (url, options) => url === '/api/layers/1/floor-plan-corners' ? pending.promise : h.defaultRequest(url, options);
  const sync = h.autosync(); await turn();
  draft(h);
  pending.resolve({ data: { layerId: 1, revision: 2, ...h.corners.get(1) } });
  await sync;
  assert.equal(h.state.workspace.revision, 1);
  assert.equal(h.state.workspace.corners.points[0].longitude, 126.9);
  assert.equal(h.corners.get(1).points[0].longitude, 1);
  assert.match(h.state.workspace.corners.error, /충돌/);
});

test('obsolete corner reads cannot replace the last selected layer', async () => {
  const h = await workspace(), pending = deferred();
  h.requestHook = (url, options) => url === '/api/layers/2/floor-plan-corners' ? pending.promise : h.defaultRequest(url, options);
  const switching = h.select(2); await turn();
  h.select(3);
  pending.resolve({ data: { layerId: 2, revision: 1, imageId: 'image-2', points: [{ longitude: 1, latitude: 2 }, { longitude: 3, latitude: 4 }] } });
  await switching;
  assert.equal(h.state.workspace.layerId, 3);
  assert.equal(h.state.workspace.corners.imageId, null);
  assert.equal(h.replacements.some((collection) => collection.features[0]?.properties.name === 'floor-2'), false);
});

test('map picking uses a distinct overlay, blocks drawing events, and rejects pitched camera input', async () => {
  const h = await workspace(); h.emitCamera(); h.handlers.onCornerImage();
  const picker = h.elements.find((element) => element.className === 'imgovl-corner-picker');
  let prevented = 0, stopped = 0;
  const event = { clientX: 500, clientY: 400, preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  h.handlers.onCornerPick(0);
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) picker.emit(type, event);
  assert.equal(prevented, 4); assert.equal(stopped, 4);
  assert.equal(h.state.workspace.corners.points[0].longitude, 126);
  assert.ok(Math.abs(h.state.workspace.corners.points[0].latitude - 37) < 1e-10);
  assert.equal(h.geojson.features.length, 1);
  assert.equal(h.requests.filter((request) => request.method).length, 0);
  h.emitCamera({ pitch: 35 }); h.handlers.onCornerPick(1);
  assert.equal(h.state.workspace.corners.picking, null);
  assert.match(h.status.textContent, /기울임/);
});

test('a failed obsolete corner request still proceeds to the newest selected layer', async () => {
  const h = await workspace(), pending = deferred();
  h.requestHook = (url, options) => url === '/api/layers/2/floor-plan-corners' ? pending.promise : h.defaultRequest(url, options);
  const switching = h.select(2); await turn(); h.select(3);
  pending.reject(new Error('stale read failure')); await switching;
  assert.equal(h.state.workspace.layerId, 3);
  assert.equal(h.state.workspace.corners.imageId, null);
});

test('image selection preserves the saved association and shared layers never load or save corners', async () => {
  const h = await workspace(); draft(h); await h.handlers.onCornerSave();
  h.state.photos.push({ id: 2, remoteId: 'another-image', name: 'other.png' });
  h.handlers.onSelect(2);
  assert.equal(h.state.workspace.corners.imageId, 'image-1');
  h.handlers.onCornerImage();
  assert.equal(h.state.workspace.corners.imageId, 'another-image');
  assert.deepEqual(plain(h.state.workspace.corners.points), [null, null]);
  h.handlers.onCornerDiscard();
  assert.equal(h.state.workspace.corners.imageId, 'image-1');
  h.state.workspace.layers[1].kind = 'SHARED_PATHS'; h.snapshots.get(2).images = [];
  h.requests.length = 0; await h.select(2);
  h.handlers.onCornerImage(); h.handlers.onCornerCoordinate(0, 1, 2);
  assert.equal(h.requests.some((request) => request.url === '/api/layers/2/floor-plan-corners'), false);
  assert.equal(h.state.workspace.corners.imageId, null);
});
