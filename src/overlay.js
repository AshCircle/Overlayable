// overlay.js — 오버레이 컨테이너 + 프레임(이미지 + 조작 핸들)을 생성하고, 상태를 DOM에 반영한다.
// 로드 순서: transform.js 다음, panel.js 이전.
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const { toTransform, clampScale, round } = NS.transform;

  // 8개 리사이즈 핸들 정의. id: 위치 클래스, sx/sy: 로컬 부호(원점=중심).
  //  - 꼭짓점: sx,sy ∈ {±1}
  //  - 좌/우 모서리: sx=±1, sy=0  /  상/하 모서리: sx=0, sy=±1
  const HANDLE_DEFS = [
    { id: 'nw', sx: -1, sy: -1 },
    { id: 'n', sx: 0, sy: -1 },
    { id: 'ne', sx: 1, sy: -1 },
    { id: 'e', sx: 1, sy: 0 },
    { id: 'se', sx: 1, sy: 1 },
    { id: 's', sx: 0, sy: 1 },
    { id: 'sw', sx: -1, sy: 1 },
    { id: 'w', sx: -1, sy: 0 },
  ];

  // 오버레이 DOM 생성.
  // 컨테이너는 항상 pointer-events:none(전체 화면을 덮지만 클릭은 통과).
  // frame: 변형(translate/rotate) + 크기(px) 기준 박스. 자식으로 이미지 + 핸들을 둔다.
  // 핸들은 frame 의 자식이라 회전을 함께 받지만, frame 에 scale 을 걸지 않으므로 고정 크기를 유지한다.
  function create() {
    const container = document.createElement('div');
    container.className = 'imgovl-overlay';

    const frame = document.createElement('div');
    frame.className = 'imgovl-frame';

    const img = document.createElement('img');
    img.className = 'imgovl-overlay-img';
    img.alt = '';
    img.draggable = false; // 브라우저 기본 이미지 드래그(고스트) 방지

    // 회전 핸들 연결선 + 회전 핸들(상단).
    const rotLine = document.createElement('div');
    rotLine.className = 'imgovl-rot-line';
    const rotHandle = document.createElement('div');
    rotHandle.className = 'imgovl-rot-handle';
    rotHandle.dataset.imgovlRot = '1';

    // 리사이즈 핸들 8개.
    const handles = {};
    const handleEls = [];
    for (const def of HANDLE_DEFS) {
      const h = document.createElement('div');
      h.className = `imgovl-handle imgovl-handle-${def.id}`;
      h.dataset.imgovlHandle = def.id;
      handles[def.id] = h;
      handleEls.push(h);
    }

    frame.appendChild(img);
    frame.appendChild(rotLine);
    frame.appendChild(rotHandle);
    for (const h of handleEls) frame.appendChild(h);
    container.appendChild(frame);

    return { container, frame, img, handles, handleEls, rotHandle, HANDLE_DEFS };
  }

  // 상태를 오버레이 DOM에 반영한다.
  // - 표시 여부: UI 활성(active) + 이미지 존재(visible, src) + 자연 크기 로드 완료(naturalW>0)
  // - frame: transform(translate/rotate) + width/height(naturalW/H × scale)
  // - opacity 는 이미지에만(핸들에는 영향 없도록).
  // - 핸들/이미지 pointer-events: 이미지 조작 모드(image)에서만 활성.
  function apply(els, state) {
    const { frame, img } = els;

    // src 는 표시 여부와 무관하게 먼저 동기화한다.
    // (load 이벤트가 떠야 naturalW/H 가 채워지고, 그래야 아래 표시 조건이 충족된다)
    if (state.src) {
      if (img.getAttribute('src') !== state.src) img.src = state.src;
    } else if (img.getAttribute('src')) {
      img.removeAttribute('src');
    }

    const shouldShow =
      state.active && state.visible && !!state.src && state.naturalW > 0 && state.naturalH > 0;

    if (!shouldShow) {
      frame.style.display = 'none';
      // host 페이지의 img { ... !important } 규칙을 이기도록 inline !important 로 고정.
      img.style.setProperty('pointer-events', 'none', 'important');
      frame.classList.remove('imgovl-image-mode');
      return;
    }

    const s = clampScale(state.scale ?? 1);
    frame.style.display = 'block';
    frame.style.width = round(state.naturalW * s, 2) + 'px';
    frame.style.height = round(state.naturalH * s, 2) + 'px';
    frame.style.transform = toTransform(state);
    img.style.opacity = String(state.opacity);

    const imageMode = state.mode === 'image';
    frame.classList.toggle('imgovl-image-mode', imageMode);
    // image 모드에서만 이미지가 이벤트를 받아 드래그/휠 조작 가능(핸들 표시·활성은 CSS 클래스로).
    // host 페이지의 img { ... !important } 규칙을 이기도록 inline !important 로 고정.
    img.style.setProperty('pointer-events', imageMode ? 'auto' : 'none', 'important');
    img.style.setProperty('cursor', imageMode ? 'grab' : 'default', 'important');
  }

  NS.overlay = { create, apply };
})();
