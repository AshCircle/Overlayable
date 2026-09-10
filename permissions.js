'use strict';
const allow = document.getElementById('allow');
const status = document.getElementById('status');
try {
  const server = new URL(decodeURIComponent(location.hash.slice(1)));
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password) {
    throw new Error('올바른 HTTP(S) 서버 주소가 필요합니다.');
  }
  const pattern = `${server.protocol}//${server.hostname}/*`;
  document.getElementById('server').textContent = server.origin;
  if (server.protocol === 'http:') {
    document.getElementById('warning').textContent = 'HTTP 연결은 관리자 키와 데이터를 암호화하지 않습니다. 외부 서버는 HTTPS 사용을 권장합니다.';
  }
  allow.disabled = false;
  allow.addEventListener('click', async () => {
    try {
      // Keep this call directly in the click handler, before any await.
      const granted = await chrome.permissions.request({ origins: [pattern] });
      status.textContent = granted
        ? '허용되었습니다. geojson.io로 돌아가 연결을 다시 누르세요. 이 탭은 닫아도 됩니다.'
        : '권한을 허용하지 않았습니다. 연결하려면 접근 허용을 다시 누르세요.';
      allow.disabled = granted;
    } catch (error) { status.textContent = `권한 요청 실패: ${error.message}`; }
  });
} catch (error) { status.textContent = error.message; }
