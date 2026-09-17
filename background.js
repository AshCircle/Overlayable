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
    let body;
    if (message.bodyType === 'image-form') {
      const bytes = Uint8Array.from(atob(message.body.base64), (c) => c.charCodeAt(0));
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { method: message.method || 'GET', headers, body, signal: controller.signal });
      const contentType = response.headers.get('content-type') || '';
      let data;
      if (message.responseType === 'base64') {
        const bytes = new Uint8Array(await response.arrayBuffer());
        // Chunk conversion avoids allocating a linked string per byte for large floor plans.
        const chunks = [];
        for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
        data = btoa(chunks.join(''));
      } else if (contentType.includes('json')) data = await response.json();
      else data = await response.text();
      sendResponse({ ok: response.ok, status: response.status, data,
        etag: response.headers.get('etag'), contentType });
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
  })().catch((error) => sendResponse({ ok: false, status: 0, error: error.message }));
  return true;
});
