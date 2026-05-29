// content.js — 진입점. 상태 단일 소스를 두고, 오버레이/패널을 주입하며,
// 키·모드 상태와 직접 상호작용(드래그/휠), 툴바 토글 메시지를 처리한다.
// 로드 순서: transform.js, overlay.js, panel.js 다음 (가장 마지막).
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  if (NS.mounted) return; // 중복 주입 방지
  NS.mounted = true;

  const T = NS.transform;

  // ---- 상태 (단일 소스) ----
  const state = {
    active: false, // 툴바 토글로 켜진 UI 표시 여부
    src: null, // object URL
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    visible: false, // 이미지 로드/표시 여부
    mode: 'web', // 'web' | 'image'
  };

  // ---- DOM 주입 ----
  const overlayEls = NS.overlay.create();
  const root = document.createElement('div');
  root.className = 'imgovl-root';
  root.appendChild(overlayEls.container);

  // 패널 핸들러: 컨트롤 → state 갱신 → applyState
  const panelApi = NS.panel.create({
    onUpload: (file) => loadImage(file),
    onOpacity: (pct) => {
      state.opacity = T.clamp(pct / 100, 0, 1);
      applyState();
    },
    onScale: (pct) => {
      state.scale = T.clampScale(pct / 100);
      applyState();
    },
    onScaleStep: (delta) => {
      state.scale = T.clampScale(T.round(state.scale + delta, 4));
      applyState();
    },
    onRotation: (deg) => {
      state.rotation = T.clampRotation(deg);
      applyState();
    },
    onRotateStep: (delta) => {
      state.rotation = T.clampRotation(state.rotation + delta);
      applyState();
    },
    onReset: () => {
      resetTransform();
      state.opacity = 1;
      applyState();
    },
    onRemove: () => removeImage(),
  });
  root.appendChild(panelApi.panel);

  document.documentElement.appendChild(root);

  // ---- 상태 → DOM 반영 (단일 지점) ----
  function applyState() {
    root.style.display = state.active ? 'block' : 'none';
    NS.overlay.apply(overlayEls, state);
    panelApi.sync(state);
  }

  function resetTransform() {
    state.x = 0;
    state.y = 0;
    state.scale = 1;
    state.rotation = 0;
  }

  // ---- 이미지 로드/제거 (objectURL 수명 관리) ----
  function loadImage(file) {
    if (state.src) URL.revokeObjectURL(state.src);
    state.src = URL.createObjectURL(file);
    state.visible = true;
    resetTransform(); // 새 이미지는 중앙·기본 크기로
    if (!state.active) state.active = true; // 업로드 시 자동으로 UI 표시
    applyState();
  }

  function removeImage() {
    if (state.src) URL.revokeObjectURL(state.src);
    state.src = null;
    state.visible = false;
    resetTransform();
    applyState();
  }

  // ---- 모드 전환 (Ctrl 홀드) ----
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    applyState();
  }

  // capture 단계에서 받아 host 페이지 핸들러와의 충돌을 줄인다.
  // keydown/keyup 에서 preventDefault 하지 않아 브라우저 단축키(Ctrl+C 등)는 그대로 동작.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Control') setMode('image');
    },
    true
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Control') setMode('web');
    },
    true
  );
  // stuck 방지: 탭 전환/포커스 상실 시 keyup 유실 대비.
  window.addEventListener('blur', () => setMode('web'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setMode('web');
  });

  // ---- 직접 상호작용: 드래그 이동 ----
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOrigX = 0;
  let dragOrigY = 0;

  overlayEls.img.addEventListener('mousedown', (e) => {
    if (state.mode !== 'image' || !state.visible) return;
    e.preventDefault();
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOrigX = state.x;
    dragOrigY = state.y;
    overlayEls.img.style.cursor = 'grabbing';
  });
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!dragging) return;
      state.x = dragOrigX + (e.clientX - dragStartX);
      state.y = dragOrigY + (e.clientY - dragStartY);
      applyState();
    },
    true
  );
  window.addEventListener(
    'mouseup',
    () => {
      if (!dragging) return;
      dragging = false;
      applyState(); // 커서를 grab 으로 복귀
    },
    true
  );

  // ---- 직접 상호작용: 휠 줌(커서 기준) / Shift+휠 회전 ----
  overlayEls.img.addEventListener(
    'wheel',
    (e) => {
      if (state.mode !== 'image' || !state.visible) return;
      e.preventDefault(); // 페이지 스크롤 및 Ctrl+휠 페이지 줌 차단

      if (e.shiftKey) {
        const delta = e.deltaY > 0 ? -5 : 5;
        state.rotation = T.clampRotation(state.rotation + delta);
        applyState();
        return;
      }

      const oldScale = state.scale;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = T.clampScale(oldScale * factor);
      if (newScale === oldScale) return;

      // 커서 위치 기준 줌: 커서 아래 지점이 고정되도록 x/y 보정 (회전 0 기준 근사).
      const ratio = newScale / oldScale;
      const cx = window.innerWidth / 2 + state.x; // 이미지 중심의 화면 x
      const cy = window.innerHeight / 2 + state.y; // 이미지 중심의 화면 y
      state.x = e.clientX - ratio * (e.clientX - cx) - window.innerWidth / 2;
      state.y = e.clientY - ratio * (e.clientY - cy) - window.innerHeight / 2;
      state.scale = newScale;
      applyState();
    },
    { capture: true, passive: false }
  );

  // ---- 툴바 토글 메시지 수신 ----
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'OVERLAYABLE_TOGGLE') {
        state.active = !state.active;
        applyState();
      }
    });
  }

  // ---- SPA 대비: 루트가 분리되면 재부착 ----
  function ensureMounted() {
    if (!root.isConnected && document.documentElement) {
      document.documentElement.appendChild(root);
    }
  }
  const observer = new MutationObserver(() => ensureMounted());
  observer.observe(document.documentElement, { childList: true });

  // 초기 반영 (active=false → 숨김 상태)
  applyState();
})();
