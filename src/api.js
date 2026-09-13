// Isolated-world client for the HongGwart admin API.
(function () {
  'use strict';
  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const LOCAL_KEY = 'overlayable_backend_url';
  const LAST_LAYER_KEY = 'overlayable_last_layer_id';

  async function settings() {
    const response = await chrome.runtime.sendMessage({ type: 'OVERLAYABLE_SETTINGS' });
    if (!response?.ok) throw new Error(response?.error || '연결 설정을 읽지 못했습니다.');
    return response.data;
  }
  async function configure(baseUrl, apiKey) {
    const response = await chrome.runtime.sendMessage({ type: 'OVERLAYABLE_CONFIGURE', baseUrl, apiKey });
    if (!response?.ok) throw new Error(response?.error || '연결 설정을 저장하지 못했습니다.');
  }
  async function request(path, options) {
    const response = await chrome.runtime.sendMessage({
      type: 'OVERLAYABLE_API',
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
