const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspace, turn, deferred, collection } = require('./helpers/workspace.cjs');

test('clean switch keeps pending selection through panel polling and skips old layer fetch', async () => {
  const h = await workspace(), pending = deferred();
  h.requestHook = (url, options) => url === '/api/admin/layers/2/snapshot?protocolVersion=2' ? pending.promise : h.defaultRequest(url, options);
  const switching = h.select(2);
  await turn(); h.pollPanel();
  assert.equal(h.layerSelect.value, '2');
  assert.match(h.status.textContent, /2층 전환 중/);
  assert.equal(h.state.workspace.layerId, 1);
  assert.deepEqual(h.requests.map(r => r.url), ['/api/admin/layers/2/snapshot?protocolVersion=2']);
  await h.autosync();
  assert.equal(h.requests.length, 1);
  pending.resolve({ data: structuredClone(h.snapshots.get(2)) });
  await switching;
  assert.equal(h.state.workspace.layerId, 2);
  assert.equal(h.layerSelect.getAttribute('aria-busy'), 'false');
  assert.match(h.status.textContent, /동기화됨/);
});

test('latest selection wins even when an obsolete snapshot request fails', async () => {
  const h = await workspace(), pending = deferred();
  h.requestHook = (url, options) => url === '/api/admin/layers/2/snapshot?protocolVersion=2' ? pending.promise : h.defaultRequest(url, options);
  const first = h.select(2);
  await turn();
  assert.equal(h.select(3), first);
  h.pollPanel(); assert.equal(h.layerSelect.value, '3');
  pending.reject(Error('old request timed out'));
  await first;
  assert.equal(h.state.workspace.layerId, 3);
  assert.deepEqual(h.replacements, [collection(3)]);
  assert.equal(h.requests.some(r => r.url === '/images/2'), false);
});

test('a stale image download never replaces the graph; returning to current layer cancels switch', async () => {
  for (const target of [1, 3]) {
    const h = await workspace(), pending = deferred();
    h.requestHook = (url, options) => url === '/images/2' ? pending.promise : h.defaultRequest(url, options);
    const first = h.select(2);
    await turn();
    h.select(target);
    assert.deepEqual(h.geojson, collection(1));
    pending.resolve({ data: 'old-image' });
    await first;
    assert.equal(h.state.workspace.layerId, target);
    assert.deepEqual(h.replacements, target === 1 ? [] : [collection(3)]);
  }
});

test('repeated clicks during a save serialize the flush and load only the final target', async () => {
  const h = await workspace(), pending = deferred();
  h.geojson.features[0].properties.name = 'edited';
  h.requestHook = async (url, options) => {
    if (options.method === 'PUT') await pending.promise;
    return h.defaultRequest(url, options);
  };
  const first = h.select(2);
  await turn();
  h.select(3); h.pollPanel();
  assert.equal(h.layerSelect.value, '3');
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
  pending.resolve(); await first;
  assert.equal(h.snapshots.get(1).geojson.features[0].properties.name, 'edited');
  assert.equal(h.state.workspace.layerId, 3);
  assert.equal(h.requests.some(r => r.url.includes('/layers/2/')), false);
  assert.equal(h.requests.some(r => r.url === '/images/1'), false);
});

test('save conflicts stop the switch and preserve local edits and old image', async () => {
  const h = await workspace();
  h.geojson.features[0].properties.name = 'unsaved';
  h.snapshots.get(1).revision++;
  await h.select(2);
  assert.equal(h.state.workspace.layerId, 1);
  assert.equal(h.state.workspace.pendingLayerId, null);
  assert.equal(h.layerSelect.value, '1');
  assert.equal(h.geojson.features[0].properties.name, 'unsaved');
  assert.equal(h.state.photos[0].name, 'floor-1.png');
  assert.match(h.status.textContent, /충돌/);
  assert.equal(h.requests.some(r => r.url.includes('/layers/2/')), false);
});

test('image failure preserves the current graph and allows retry', async () => {
  const h = await workspace();
  h.requestHook = (url, options) => url === '/images/2' ? Promise.reject(Error('image timeout')) : h.defaultRequest(url, options);
  await h.select(2);
  assert.equal(h.state.workspace.layerId, 1);
  assert.deepEqual(h.geojson, collection(1));
  assert.equal(h.replacements.length, 0);
  assert.equal(h.layerSelect.value, '1');
  assert.match(h.status.textContent, /image timeout/);
  h.requestHook = null;
  await h.select(2);
  assert.equal(h.state.workspace.layerId, 2);
});

test('versioned image cache reuses bytes across switches and invalidates changed hashes', async () => {
  const h = await workspace();
  await h.select(2); await h.select(1); await h.select(2);
  assert.deepEqual(h.requests.filter(r => r.url.startsWith('/images/')).map(r => r.url), ['/images/2']);
  await h.select(1);
  h.snapshots.get(2).images[0].contentHash = 'new-hash';
  await h.select(2);
  assert.equal(h.requests.filter(r => r.url === '/images/2').length, 2);
});

test('image cache is scoped to backend URL and bypasses missing content hashes', async () => {
  const h = await workspace();
  await h.select(2); await h.select(1);
  await h.handlers.onConnect('https://other.invalid', '');
  await h.select(2);
  assert.equal(h.requests.filter(r => r.url === '/images/2').length, 2);
  delete h.snapshots.get(1).images[0].contentHash;
  await h.select(1); await h.select(2); await h.select(1);
  assert.equal(h.requests.filter(r => r.url === '/images/1').length, 2);
});

test('edits made while downloading a target image are flushed before switching', async () => {
  const h = await workspace(), pending = deferred();
  h.requestHook = (url, options) => url === '/images/2' ? pending.promise : h.defaultRequest(url, options);
  const first = h.select(2);
  await turn();
  h.geojson.features[0].properties.name = 'edited during download';
  pending.resolve({ data: 'image' });
  await first;
  assert.equal(h.snapshots.get(1).geojson.features[0].properties.name, 'edited during download');
  assert.equal(h.state.workspace.layerId, 2);
});

test('edits made during an in-flight save survive and are saved before leaving', async () => {
  const h = await workspace(), pending = deferred();
  h.geojson.features[0].properties.name = 'first edit';
  let writes = 0;
  h.requestHook = async (url, options) => {
    if (options.method === 'PUT' && ++writes === 1) await pending.promise;
    return h.defaultRequest(url, options);
  };
  const autosync = h.autosync();
  await turn();
  const first = h.select(2);
  h.geojson.features[0].properties.name = 'latest edit';
  pending.resolve();
  await Promise.all([autosync, first]);
  assert.equal(h.snapshots.get(1).geojson.features[0].properties.name, 'latest edit');
  assert.equal(writes, 2);
  assert.equal(h.state.workspace.layerId, 2);
});

test('panel polling does not rewrite an open native select or move existing thumbnails', async () => {
  const h = await workspace();
  h.layerSelect.value = '2'; // Native selection before its change event is committed.
  const item = h.elements.find(el => el.className === 'imgovl-photo-item');
  const photoList = item.parentElement;
  const insert = photoList.insertBefore;
  photoList.insertBefore = () => { throw Error('unnecessary thumbnail move'); };
  h.pollPanel();
  assert.equal(h.layerSelect.value, '2');
  photoList.insertBefore = insert;
});

test('a pending image deletion is awaited and a failure blocks switching until reload', async () => {
  const h = await workspace(), pending = deferred();
  h.requestHook = (url, options) => options.method === 'DELETE' ? pending.promise : h.defaultRequest(url, options);
  h.handlers.onDelete(h.state.photos[0].id);
  const switching = h.select(2);
  await turn();
  assert.equal(h.requests.some(r => r.url.includes('/layers/2/')), false);
  pending.reject(Error('image deletion failed'));
  await switching;
  assert.equal(h.state.workspace.layerId, 1);
  assert.match(h.status.textContent, /image deletion failed/);
  h.requestHook = null;
  await h.handlers.onLayerReload();
  await h.select(2);
  assert.equal(h.state.workspace.layerId, 2);
});

test('remote polling cannot overwrite edits made while waiting for its response', async () => {
  const h = await workspace(), pending = deferred();
  h.snapshots.get(1).revision++;
  h.snapshots.get(1).geojson.features[0].properties.name = 'remote edit';
  h.requestHook = (url, options) => !options.method && url === '/api/admin/layers/1/snapshot?protocolVersion=2'
    ? pending.promise : h.defaultRequest(url, options);
  const sync = h.autosync();
  await turn();
  h.geojson.features[0].properties.name = 'local edit';
  const switching = h.select(2);
  pending.resolve({ data: structuredClone(h.snapshots.get(1)) });
  await Promise.all([sync, switching]);
  assert.equal(h.state.workspace.layerId, 1);
  assert.equal(h.geojson.features[0].properties.name, 'local edit');
  assert.match(h.status.textContent, /충돌/);
  assert.equal(h.requests.some(r => r.url.includes('/layers/2/')), false);
});
