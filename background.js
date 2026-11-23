// background.js — MV3 서비스 워커.
// 툴바 아이콘 클릭 시 현재 탭의 콘텐츠 스크립트에 패널 토글 메시지를 보낸다.
// activeTab 권한으로 클릭 시점에 현재 탭 host 권한이 부여되어 sendMessage 가 도달한다.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  chrome.tabs
    .sendMessage(tab.id, { type: 'OVERLAYABLE_TOGGLE' })
    .catch(() => {
      // 콘텐츠 스크립트가 없는 페이지(chrome://, 웹스토어 등) 또는
      // 익스텐션 설치 전 로드된 탭이면 무시한다. 새로고침 후 재시도하면 동작.
    });
});

// Admin key and response bodies never enter geojson.io's MAIN world. All network
// traffic crosses this service-worker boundary from the isolated content script.
// Keep original image bytes in extension-owned storage, rather than serializing
// large base64 strings into chrome.storage on every page reload. Only immutable,
// server-versioned content is reused; graph and transform requests always go live.
const IMAGE_CACHE_NAME = 'overlayable-images-v1';
const IMAGE_CACHE_BYTES = 128 * 1024 * 1024;
const IMAGE_CACHE_ENTRIES = 256;
const imageRequests = new Map();
const imageDownloadWaiters = [];
let imageDownloads = 0;
let imageCacheWrites = Promise.resolve();

function imageCacheKey(url, contentHash) {
  if (!/^[a-f0-9]{64}$/i.test(contentHash || '')) return null;
  const key = new URL(url);
  key.searchParams.set('__overlayable_content_hash', contentHash.toLowerCase());
  return key.href;
}

async function cachedImage(key) {
  if (!key || typeof caches === 'undefined') return null;
  try { return await (await caches.open(IMAGE_CACHE_NAME)).match(key); }
  catch (_) { return null; } // Storage denial/eviction must not prevent editing.
}

function rememberImage(key, bytes, contentType, etag) {
  if (!key || typeof caches === 'undefined' || typeof contentType !== 'string' || !contentType.startsWith('image/')
      || !bytes.byteLength || bytes.byteLength > IMAGE_CACHE_BYTES) return Promise.resolve();
  // Serialize eviction and writes across all tabs using this service worker. Cache
  // insertion order provides bounded FIFO eviction without rewriting image bodies
  // just to update a timestamp whenever an already-cached floor is visited.
  imageCacheWrites = imageCacheWrites.then(async () => {
    const cache = await caches.open(IMAGE_CACHE_NAME);
    if (await cache.match(key)) return;
    const entries = [];
    let total = 0;
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const size = Number(response?.headers.get('x-overlayable-bytes'));
      if (!Number.isFinite(size) || size <= 0) { await cache.delete(request); continue; }
      entries.push({ request, size }); total += size;
    }
    while (entries.length && (total + bytes.byteLength > IMAGE_CACHE_BYTES || entries.length >= IMAGE_CACHE_ENTRIES)) {
      const oldest = entries.shift();
      await cache.delete(oldest.request); total -= oldest.size;
    }
    const headers = { 'content-type': contentType, 'x-overlayable-bytes': String(bytes.byteLength) };
    if (etag) headers.etag = etag;
    await cache.put(key, new Response(bytes, { headers }));
  }).catch(() => {});
  return imageCacheWrites;
}

async function withImageDownloadSlot(operation) {
  if (imageDownloads >= 2) await new Promise(resolve => imageDownloadWaiters.push(resolve));
  else imageDownloads++;
  try { return await operation(); }
  finally {
    const next = imageDownloadWaiters.shift();
    if (next) next(); else imageDownloads--;
  }
}

function encodeImage(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(chunks.join(''));
}

async function imageResponse(response, key) {
  const contentType = response.headers.get('content-type') || '';
  const etag = response.headers.get('etag');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.ok) await rememberImage(key, bytes, contentType, etag);
  return { ok: response.ok, status: response.status, data: encodeImage(bytes), etag, contentType };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !['OVERLAYABLE_API', 'OVERLAYABLE_SETTINGS', 'OVERLAYABLE_CONFIGURE'].includes(message.type)) return;
  (async () => {
    const localKey = 'overlayable_backend_url';
    const sessionKey = 'overlayable_admin_key';
    if (message.type === 'OVERLAYABLE_CONFIGURE') {
      const configured = new URL(message.baseUrl);
      if (!['http:', 'https:'].includes(configured.protocol)) throw new Error('HTTP(S) 백엔드 URL이 필요합니다.');
      if (configured.username || configured.password || configured.search || configured.hash) {
        throw new Error('백엔드 URL에는 계정 정보, 쿼리 또는 fragment를 넣지 마세요.');
      }
      // Host permissions cover the host's ports; the actual API URL retains its port.
      const pattern = `${configured.protocol}//${configured.hostname}/*`;
      if (!await chrome.permissions.contains({ origins: [pattern] })) {
        // A content-script message is not a reliable user gesture for permissions.request.
        // Ask from a dedicated extension page's button instead. Never put the key in its URL.
        await chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') + '#' + encodeURIComponent(configured.origin) });
        throw new Error('열린 권한 화면에서 접근을 허용한 뒤, geojson.io로 돌아와 연결을 다시 누르세요.');
      }
      await chrome.storage.local.set({ [localKey]: String(message.baseUrl).replace(/\/$/, '') });
      await chrome.storage.session.set({ [sessionKey]: message.apiKey || '' });
      sendResponse({ ok: true });
      return;
    }
    const [local, session] = await Promise.all([
      chrome.storage.local.get([localKey, 'overlayable_last_layer_id']),
      chrome.storage.session.get(sessionKey),
    ]);
    const baseUrl = local[localKey] || 'http://localhost:8080';
    if (message.type === 'OVERLAYABLE_SETTINGS') {
      sendResponse({ ok: true, data: { baseUrl, hasApiKey: !!session[sessionKey],
        lastLayerId: local.overlayable_last_layer_id || null } });
      return;
    }
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('HTTP(S) 백엔드 URL이 필요합니다.');
    const url = new URL(baseUrl + String(message.path || ''));
    const headers = new Headers(message.headers || {});
    if (session[sessionKey]) headers.set('X-Honggwart-Admin-Key', session[sessionKey]);
    let body, uploadedBytes;
    if (message.bodyType === 'image-form') {
      const bytes = Uint8Array.from(atob(message.body.base64), (c) => c.charCodeAt(0));
      uploadedBytes = bytes;
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: message.body.contentType }), message.body.name);
      body = form;
    } else if (message.bodyType === 'base64') {
      const bytes = Uint8Array.from(atob(message.body), (c) => c.charCodeAt(0));
      body = bytes;
    } else if (message.body != null) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(message.body);
    }
    const binaryRead = message.responseType === 'base64' && (!message.method || message.method === 'GET');
    const cacheKey = binaryRead ? imageCacheKey(url, message.contentHash) : null;
    const performRequest = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(url, { method: message.method || 'GET', headers, body, signal: controller.signal });
        if (message.responseType === 'base64') return await imageResponse(response, cacheKey);
        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('json') ? await response.json() : await response.text();
        if (response.ok && uploadedBytes && data?.contentUrl && data?.contentHash) {
          // The server stores uploads verbatim and returns their SHA-256 identity.
          // Reuse the local file immediately, including after an extension restart.
          try {
            const uploadedKey = imageCacheKey(new URL(baseUrl + data.contentUrl), data.contentHash);
            await rememberImage(uploadedKey, uploadedBytes, data.contentType || message.body.contentType, '"' + data.contentHash + '"');
          } catch (_) { /* Caching cannot turn a successful upload into a failed write. */ }
        }
        return { ok: response.ok, status: response.status, data,
          etag: response.headers.get('etag'), contentType };
      } catch (error) {
        if (controller.signal.aborted) {
          const writing = message.method && !['GET', 'HEAD'].includes(message.method);
          throw new Error('서버 응답 시간이 초과되었습니다(20초).' + (writing
            ? ' 저장이 서버에서 처리되었을 수 있습니다. 로컬 데이터를 내보낸 뒤 원격 상태를 확인하세요.'
            : ' 연결 상태를 확인한 뒤 다시 시도하세요.'));
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };
    if (!binaryRead) { sendResponse(await performRequest()); return; }
    // Share pending reads across tabs, and cap concurrent uncached downloads to
    // avoid memory/network bursts when a layer includes many reference plans.
    if (cacheKey && imageRequests.has(cacheKey)) { sendResponse(await imageRequests.get(cacheKey)); return; }
    const pending = (async () => {
      const cached = await cachedImage(cacheKey);
      if (cached) {
        try { return await imageResponse(cached, null); } catch (_) { /* retry a damaged cache entry online */ }
      }
      return withImageDownloadSlot(performRequest);
    })();
    if (cacheKey) imageRequests.set(cacheKey, pending);
    try { sendResponse(await pending); }
    finally {
      if (cacheKey) imageRequests.delete(cacheKey);
    }
  })().catch((error) => sendResponse({ ok: false, status: 0, error: error.message }));
  return true;
});
