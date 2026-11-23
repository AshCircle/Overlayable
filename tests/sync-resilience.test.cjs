const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspace } = require('./helpers/workspace.cjs');

test('idle polling reads only revisions and loads the graph when a dependency changes', async () => {
  const h = await workspace();
  await h.autosync(); await h.autosync();
  assert.deepEqual(h.requests.map(r => r.url), Array(2).fill('/api/admin/layers/1/revision?protocolVersion=2'));
  h.snapshots.get(1).referenceRevisions = { 2: 9 };
  await h.autosync();
  assert.equal(h.requests.filter(r => r.url.includes('/snapshot')).length, 1);
  assert.equal(h.state.workspace.referenceRevisions[2], 9);
});

test('old servers fall back once to snapshot polling, but unavailable servers do not', async () => {
  for (const status of [404, 503]) {
    const h = await workspace();
    h.requestHook = (url, opts) => {
      if (url.includes('/revision?')) throw Object.assign(Error('unavailable'), { status });
      return h.defaultRequest(url, opts);
    };
    await h.autosync(); await h.autosync();
    assert.equal(h.requests.filter(r => r.url.includes('/revision?')).length, 1);
    assert.equal(h.requests.filter(r => r.url.includes('/snapshot?')).length, status === 404 ? 2 : 0);
  }
});

test('hidden tabs stop remote polling but still save local edits', async () => {
  const h = await workspace();
  h.document.hidden = true;
  await h.autosync();
  assert.equal(h.requests.length, 0);
  h.geojson.features[0].properties.name = 'background edit';
  await h.autosync();
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(h.snapshots.get(1).geojson.features[0].properties.name, 'background edit');
});

test('offline browser hints do not silently skip saves to a reachable backend', async () => {
  const h = await workspace();
  h.navigator.onLine = false;
  h.geojson.features[0].properties.name = 'local backend remains reachable';
  await h.autosync();
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(h.snapshots.get(1).geojson.features[0].properties.name, 'local backend remains reachable');
  h.geojson.features[0].properties.name = 'network lost';
  h.requestHook = () => { throw Object.assign(Error('Failed to fetch'), { status: 0 }); };
  await h.autosync();
  assert.equal(h.state.workspace.error, true);
  assert.match(h.state.workspace.status, /저장 결과 확인/);
});

test('read failures back off progressively and resume after recovery', async () => {
  const h = await workspace();
  h.requestHook = () => { throw Object.assign(Error('server busy'), { status: 503 }); };
  await h.autosync();
  h.advanceTime(9999); await h.autosync();
  assert.equal(h.requests.length, 1);
  h.advanceTime(1); await h.autosync();
  h.advanceTime(10000); await h.autosync();
  assert.equal(h.requests.length, 2);
  h.advanceTime(10000); h.requestHook = null; await h.autosync();
  assert.equal(h.requests.length, 3);
  assert.equal(h.state.workspace.error, false);
  await h.autosync();
  assert.equal(h.requests.length, 4);
});

test('corner saves with a lost response are not automatically replayed', async () => {
  const h = await workspace();
  h.handlers.onCornerImage();
  h.handlers.onCornerCoordinate(0, '126.925', '37.550');
  h.handlers.onCornerCoordinate(1, '126.926', '37.551');
  h.requestHook = async (url, opts) => {
    const result = await h.defaultRequest(url, opts);
    if (opts.method === 'POST') throw Object.assign(Error('response lost after commit'), { status: 0 });
    return result;
  };
  await h.autosync();
  h.advanceTime(600000); await h.autosync();
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(h.state.workspace.corners.dirty, true);
  assert.match(h.state.workspace.status, /기준점 저장 결과 확인/);
  h.requestHook = null;
  await h.handlers.onLayerReload();
  assert.equal(h.state.workspace.corners.dirty, false);
  assert.equal(h.state.workspace.revision, 2);
});

test('uncertain writes pause automatic retries and layer switching until explicit reload', async () => {
  const h = await workspace();
  h.geojson.features[0].properties.name = 'keep this draft';
  h.requestHook = (url, opts) => {
    if (opts.method === 'PUT') throw Object.assign(Error('deadline'), { status: 0 });
    return h.defaultRequest(url, opts);
  };
  await h.autosync();
  h.advanceTime(600000); await h.autosync();
  await h.select(2);
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(h.state.workspace.layerId, 1);
  assert.equal(h.geojson.features[0].properties.name, 'keep this draft');
  assert.match(h.state.workspace.status, /저장 결과 확인/);
  h.requestHook = null;
  await h.handlers.onLayerReload();
  await h.select(2);
  assert.equal(h.state.workspace.layerId, 2);
});

test('conflicted writes are not resubmitted every tick', async () => {
  const h = await workspace();
  h.geojson.features[0].properties.name = 'draft';
  h.snapshots.get(1).revision++;
  await h.autosync();
  h.advanceTime(600000); await h.autosync();
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(h.geojson.features[0].properties.name, 'draft');
});

test('a read-only revision race retries automatically without requiring a destructive reload', async () => {
  const h = await workspace();
  h.snapshots.get(1).revision = 2;
  h.requestHook = (url, opts) => {
    if (url.endsWith('/floor-plan-corners')) h.snapshots.get(1).revision = 3;
    return h.defaultRequest(url, opts);
  };
  await h.autosync();
  assert.equal(h.state.workspace.revision, 1);
  assert.equal(h.state.workspace.error, true);
  h.requestHook = null;
  h.advanceTime(10000);
  await h.autosync();
  assert.equal(h.state.workspace.revision, 3);
  assert.equal(h.state.workspace.error, false);
  assert.equal(h.requests.some(r => r.method), false);
});

test('an acknowledged save followed by a failed read retries normalization without a duplicate write', async () => {
  const h = await workspace();
  h.geojson.features[0].properties.name = 'saved once';
  h.requestHook = async (url, opts) => {
    if (url.endsWith('/floor-plan-corners')) throw Object.assign(Error('temporary read failure'), { status: 503 });
    const response = await h.defaultRequest(url, opts);
    if (opts.method === 'PUT') {
      h.snapshots.get(1).geojson.features[0].properties.normalized = true;
      response.data.geojson.features[0].properties.normalized = true;
    }
    return response;
  };
  await h.autosync();
  assert.equal(h.state.workspace.revision, 2);
  assert.equal(h.geojson.features[0].properties.name, 'saved once');
  h.requestHook = null; h.advanceTime(10000);
  await h.autosync();
  assert.equal(h.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(h.geojson.features[0].properties.normalized, true);
});
