const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { turn } = require('./helpers/workspace.cjs');

function worker(fetch) {
  let listener;
  const timers = new Map();
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), {
    URL, Headers, AbortController, Uint8Array, btoa, fetch,
    setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: { action: { onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: { get: async () => ({ overlayable_backend_url: 'https://test.invalid' }) },
        session: { get: async () => ({}) } } },
  });
  return { timers, send: message => new Promise(resolve => listener({ type: 'OVERLAYABLE_API', path: '/snapshot', ...message }, {}, resolve)),
    expire() { for (const timer of timers.values()) { assert.equal(timer.ms, 20000); timer.fn(); } } };
}
const aborted = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

test('network deadline aborts stalled requests and returns a retryable read error', async () => {
  let signal;
  const w = worker(async (_url, options) => { signal = options.signal; return aborted(signal); });
  const result = w.send({});
  await turn(); w.expire();
  const response = await result;
  assert.equal(signal.aborted, true);
  assert.equal(response.ok, false);
  assert.match(response.error, /20초/);
  assert.equal(w.timers.size, 0);
});

test('deadline covers response bodies and explains uncertain writes without retrying', async () => {
  let count = 0;
  const w = worker(async (_url, options) => {
    count++;
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      json: () => aborted(options.signal) };
  });
  const result = w.send({ method: 'PUT', body: {} });
  await turn(); w.expire();
  const response = await result;
  assert.equal(response.ok, false);
  assert.match(response.error, /서버에서 처리되었을 수/);
  assert.equal(count, 1);
  assert.equal(w.timers.size, 0);
});

test('successful binary responses encode all chunks and release the deadline', async () => {
  const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 256);
  const w = worker(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => bytes.buffer }));
  const response = await w.send({ responseType: 'base64' });
  assert.equal(response.ok, true);
  assert.equal(response.data, Buffer.from(bytes).toString('base64'));
  assert.equal(w.timers.size, 0);
});

test('HTTP conflict response keeps its status and response body', async () => {
  const data = { error: { message: 'revision conflict' } };
  const w = worker(async () => ({ ok: false, status: 409, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => data }));
  const response = await w.send({ method: 'PUT' });
  assert.equal(response.ok, false);
  assert.equal(response.status, 409);
  assert.deepEqual(response.data, data);
  assert.equal(w.timers.size, 0);
});
