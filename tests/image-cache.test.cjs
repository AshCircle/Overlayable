const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { turn } = require('./helpers/workspace.cjs');

const hash = 'a'.repeat(64);
const path = '/api/admin/layers/1/images/image-1/content';
const png = bytes => new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'image/png', etag: '"' + hash + '"' } });

function persistentCache() {
  const entries = new Map();
  const key = request => typeof request === 'string' ? request : request.url;
  const cache = {
    match: async request => entries.get(key(request))?.clone(),
    put: async (request, response) => entries.set(key(request), response.clone()),
    delete: async request => entries.delete(key(request)),
    keys: async () => [...entries.keys()].map(url => new Request(url)),
  };
  return { entries, cache, open: async () => cache };
}

function worker(fetch, caches, baseUrl = 'https://test.invalid') {
  let listener;
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), {
    URL, Headers, Request, Response, AbortController, Uint8Array, btoa, atob, Blob, FormData,
    fetch, caches, setTimeout, clearTimeout,
    chrome: { action: { onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: { get: async () => ({ overlayable_backend_url: baseUrl }) },
        session: { get: async () => ({}) } } },
  });
  return { send: options => new Promise(resolve => listener({ type: 'OVERLAYABLE_API', path,
    responseType: 'base64', contentHash: hash, ...options }, {}, resolve)) };
}

test('image bytes persist across worker restarts and do not make a second server request', async () => {
  const cache = persistentCache();
  const first = worker(async () => png([1, 2, 3]), cache);
  assert.equal((await first.send()).data, 'AQID');
  assert.equal(cache.entries.size, 1);
  const restarted = worker(async () => { throw new Error('network must not be used'); }, cache);
  const hit = await restarted.send();
  assert.equal(hit.ok, true);
  assert.equal(hit.data, 'AQID');
  assert.equal(hit.contentType, 'image/png');
});

test('image versions, server addresses, and image URLs have separate cache identities', async () => {
  const cache = persistentCache();
  let reads = 0;
  const fetch = async () => { reads++; return png([reads]); };
  const first = worker(fetch, cache);
  await first.send();
  await first.send({ contentHash: 'b'.repeat(64) });
  await first.send({ path: '/api/admin/layers/2/images/image-2/content' });
  await worker(fetch, cache, 'https://another.invalid').send();
  await first.send();
  assert.equal(reads, 4);
  assert.equal(cache.entries.size, 4);
});

test('unversioned images and failed HTTP responses are never cached', async () => {
  const cache = persistentCache();
  let reads = 0;
  const w = worker(async () => { reads++; return png([reads]); }, cache);
  await w.send({ contentHash: undefined }); await w.send({ contentHash: undefined });
  assert.equal(reads, 2);
  assert.equal(cache.entries.size, 0);
  const failure = worker(async () => new Response('unavailable', { status: 503 }), cache);
  assert.equal((await failure.send()).status, 503);
  assert.equal(cache.entries.size, 0);
});

test('concurrent duplicate image reads share one request and only two downloads run at once', async () => {
  const cache = persistentCache();
  const releases = [];
  let reads = 0, active = 0, peak = 0;
  const w = worker(async () => {
    reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve));
    active--; return png([reads]);
  }, cache);
  const results = [w.send(), w.send(), w.send({ contentHash: 'b'.repeat(64) }), w.send({ contentHash: 'c'.repeat(64) })];
  await turn();
  assert.equal(reads, 2);
  releases.shift()(); releases.shift()();
  while (!releases.length) await turn();
  releases.shift()();
  assert.equal((await Promise.all(results)).every(result => result.ok), true);
  assert.equal(reads, 3);
  assert.equal(peak, 2);
});

test('successful local image upload primes its persistent cache without downloading it', async () => {
  const cache = persistentCache();
  const w = worker(async (_url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(await options.body.get('file').text(), 'local file');
    return Response.json({ id: 'image-1', contentHash: hash, contentType: 'image/png', contentUrl: path });
  }, cache);
  const upload = await w.send({ method: 'POST', path: '/api/admin/layers/1/images', responseType: undefined,
    bodyType: 'image-form', body: { base64: btoa('local file'), name: 'plan.png', contentType: 'image/png' } });
  assert.equal(upload.ok, true);
  const reopened = worker(async () => { throw new Error('must reuse the local upload'); }, cache);
  assert.equal((await reopened.send()).data, btoa('local file'));
});

test('storage failures do not prevent image reads or turn successful uploads into errors', async () => {
  const unavailable = { open: async () => { throw new Error('quota'); } };
  assert.equal((await worker(async () => png([1]), unavailable).send()).ok, true);
  const upload = worker(async () => Response.json({ contentHash: hash, contentType: 'image/png', contentUrl: path }), unavailable);
  const result = await upload.send({ method: 'POST', responseType: undefined, bodyType: 'image-form',
    body: { base64: 'AQID', name: 'plan.png', contentType: 'image/png' } });
  assert.equal(result.ok, true);
});

test('persistent cache evicts oldest entries to enforce both byte and entry budgets', async () => {
  const cache = persistentCache();
  // Metadata models existing files without allocating 128 MiB in the test runner.
  for (let i = 0; i < 2; i++) await cache.cache.put('https://test.invalid/old/' + i,
    new Response('old', { headers: { 'content-type': 'image/png', 'x-overlayable-bytes': String(64 * 1024 * 1024) } }));
  await worker(async () => png([1]), cache).send();
  assert.equal(cache.entries.has('https://test.invalid/old/0'), false);
  assert.equal(cache.entries.has('https://test.invalid/old/1'), true);
  assert.equal(cache.entries.size, 2);
  const many = persistentCache();
  for (let i = 0; i < 256; i++) await many.cache.put('https://test.invalid/small/' + i,
    new Response('x', { headers: { 'x-overlayable-bytes': '1' } }));
  await worker(async () => png([1]), many).send();
  assert.equal(many.entries.size, 256);
  assert.equal(many.entries.has('https://test.invalid/small/0'), false);
});
