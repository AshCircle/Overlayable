// Isolated-world client for the HongGwart admin API.
(function () {
  'use strict';
  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const LOCAL_KEY = 'overlayable_backend_url';
  const SESSION_KEY = 'overlayable_admin_key';
  const LAST_LAYER_KEY = 'overlayable_last_layer_id';

  async function settings() {
    const [local, session] = await Promise.all([
      chrome.storage.local.get(LOCAL_KEY), chrome.storage.session.get(SESSION_KEY),
    ]);
    return { baseUrl: local[LOCAL_KEY] || 'http://localhost:8080', apiKey: session[SESSION_KEY] || '',
      lastLayerId: local[LAST_LAYER_KEY] || null };
  }
  async function configure(baseUrl, apiKey) {
    const origin = new URL(baseUrl).origin + '/*';
    if (!origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error('백엔드 호스트 접근 권한이 필요합니다.');
    }
    await Promise.all([
      chrome.storage.local.set({ [LOCAL_KEY]: baseUrl.replace(/\/$/, '') }),
      chrome.storage.session.set({ [SESSION_KEY]: apiKey }),
    ]);
  }
  async function request(path, options) {
    const auth = await settings();
    const response = await chrome.runtime.sendMessage({
      type: 'OVERLAYABLE_API', baseUrl: auth.baseUrl, apiKey: auth.apiKey,
      path, method: options?.method || 'GET', body: options?.body,
      bodyType: options?.bodyType, responseType: options?.responseType,
      headers: options?.headers,
    });
    if (!response?.ok) {
      const error = new Error(response?.data?.error?.message || response?.error || `HTTP ${response?.status}`);
      error.status = response?.status || 0; error.payload = response?.data; throw error;
    }
    return response;
  }
  async function setLastLayer(id) { await chrome.storage.local.set({ [LAST_LAYER_KEY]: id }); }
  NS.api = { settings, configure, request, setLastLayer };
})();
