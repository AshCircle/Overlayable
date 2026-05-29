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
