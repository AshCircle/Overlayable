// overlay.js — 오버레이 컨테이너 + 이미지 요소를 생성하고, 상태를 DOM에 반영한다.
// 로드 순서: transform.js 다음, panel.js 이전.
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const { toTransform } = NS.transform;

  // 오버레이 DOM 생성.
  // 컨테이너는 항상 pointer-events:none(전체 화면을 덮지만 클릭은 통과),
  // 실제 상호작용 대상은 내부 <img> 한 장이다.
  function create() {
    const container = document.createElement('div');
    container.className = 'imgovl-overlay';

    const img = document.createElement('img');
    img.className = 'imgovl-overlay-img';
    img.alt = '';
    img.draggable = false; // 브라우저 기본 이미지 드래그(고스트) 방지

    container.appendChild(img);
    return { container, img };
  }

  // 상태를 오버레이 DOM에 반영한다.
  // - 표시 여부: UI 활성(active) + 이미지 존재(visible, src) 일 때만 보임
  // - transform / opacity 적용
  // - pointer-events: 이미지 조작 모드(image)에서만 auto → 이미지 영역만 이벤트 캡처
  function apply(els, state) {
    const { img } = els;
    const shouldShow = state.active && state.visible && !!state.src;

    if (shouldShow) {
      if (img.getAttribute('src') !== state.src) {
        img.src = state.src;
      }
      img.style.display = 'block';
      img.style.transform = toTransform(state);
      img.style.opacity = String(state.opacity);
      img.style.pointerEvents = state.mode === 'image' ? 'auto' : 'none';
      img.style.cursor = state.mode === 'image' ? 'grab' : 'default';
    } else {
      img.style.display = 'none';
      img.style.pointerEvents = 'none';
    }
  }

  NS.overlay = { create, apply };
})();
