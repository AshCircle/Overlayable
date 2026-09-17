const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function worker(granted) {
  let listener;
  const local = {}, session = {}, opened = [], patterns = [], requests = [];
  const storage = (data) => ({ get: async () => data, set: async (x) => Object.assign(data, x) });
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), {
    URL, Headers, AbortController, setTimeout, clearTimeout,
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } }, getURL: (p) => `chrome-extension://test/${p}` },
      permissions: { contains: async ({ origins }) => { patterns.push(...origins); return granted; } },
      tabs: { create: async (x) => opened.push(x) },
      storage: { local: storage(local), session: storage(session) },
    },
    fetch: async (url) => { requests.push(String(url)); return { ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) }; },
  });
  return { local, session, opened, patterns, requests,
    send: (message) => new Promise((resolve) => listener(message, {}, resolve)) };
}

test('external host permission omits port, API requests retain port', async () => {
  const w = worker(true);
  assert.equal((await w.send({ type: 'OVERLAYABLE_CONFIGURE', baseUrl: 'http://abx.com:8080', apiKey: 'test-key' })).ok, true);
  assert.deepEqual(w.patterns, ['http://abx.com/*']);
  await w.send({ type: 'OVERLAYABLE_API', path: '/api/admin/layers' });
  assert.deepEqual(w.requests, ['http://abx.com:8080/api/admin/layers']);
  assert.equal(w.opened.length, 0);
});

test('missing permission opens extension page without saving settings or exposing key', async () => {
  const w = worker(false);
  const result = await w.send({ type: 'OVERLAYABLE_CONFIGURE', baseUrl: 'https://abx.com:8443', apiKey: 'secret-key' });
  assert.equal(result.ok, false);
  assert.match(result.error, /연결을 다시/);
  assert.equal(w.opened[0].url, 'chrome-extension://test/permissions.html#https%3A%2F%2Fabx.com%3A8443');
  assert.deepEqual(w.local, {});
  assert.deepEqual(w.session, {});
});

test('localhost ports use existing permissions; lookalike host does not bypass check', async () => {
  const local = worker(true);
  assert.equal((await local.send({ type: 'OVERLAYABLE_CONFIGURE', baseUrl: 'http://localhost:9090' })).ok, true);
  assert.deepEqual(local.patterns, ['http://localhost/*']);
  const remote = worker(false);
  assert.equal((await remote.send({ type: 'OVERLAYABLE_CONFIGURE', baseUrl: 'http://localhost.example.com:8080' })).ok, false);
  assert.equal(remote.opened.length, 1);
});

test('rejects unsupported protocols and credentials before opening permission page', async () => {
  for (const baseUrl of ['file:///tmp/test', 'https://user:password@abx.com:8080', 'https://abx.com?key=secret']) {
    const w = worker(false);
    assert.equal((await w.send({ type: 'OVERLAYABLE_CONFIGURE', baseUrl })).ok, false);
    assert.equal(w.opened.length, 0);
  }
});

test('content client configures without accessing unavailable permissions API', async () => {
  const window = {}, messages = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/api.js'), 'utf8'), {
    window, chrome: { runtime: { sendMessage: async (m) => { messages.push(m); return { ok: true }; } } },
  });
  await window.__OVERLAYABLE__.api.configure('http://abx.com:8080', 'key');
  assert.equal(messages[0].type, 'OVERLAYABLE_CONFIGURE');
});

test('permission page requests exact host on click and handles approval, denial and errors', async () => {
  for (const outcome of [true, false, new Error('failed')]) {
    let click;
    const elements = Object.fromEntries(['allow', 'status', 'server', 'warning'].map((id) => [id, {
      disabled: true, textContent: '', addEventListener: (_, fn) => { click = fn; },
    }]));
    const calls = [];
    vm.runInNewContext(fs.readFileSync(require.resolve('../permissions.js'), 'utf8'), {
      URL, decodeURIComponent, location: { hash: '#http%3A%2F%2Fabx.com%3A8080' },
      document: { getElementById: (id) => elements[id] },
      chrome: { permissions: { request: async ({ origins }) => {
        calls.push(...origins); if (outcome instanceof Error) throw outcome; return outcome;
      } } },
    });
    assert.equal(calls.length, 0);
    await click();
    assert.deepEqual(calls, ['http://abx.com/*']);
    assert.equal(elements.allow.disabled, outcome === true);
    assert.match(elements.status.textContent, outcome === true ? /허용되었습니다/ : outcome === false ? /허용하지/ : /요청 실패/);
  }
});
