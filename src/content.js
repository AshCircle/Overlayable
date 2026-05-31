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
    naturalW: 0, // 원본 픽셀 크기 (load 시 기록) — frame 크기 산출의 기준
    naturalH: 0,
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
    state.naturalW = 0; // load 이벤트 전까지는 숨김(naturalW>0 조건)
    state.naturalH = 0;
    resetTransform(); // 새 이미지는 중앙·기본 크기로
    if (!state.active) state.active = true; // 업로드 시 자동으로 UI 표시
    applyState();
  }

  function removeImage() {
    if (state.src) URL.revokeObjectURL(state.src);
    state.src = null;
    state.visible = false;
    state.naturalW = 0;
    state.naturalH = 0;
    resetTransform();
    applyState();
  }

  // 이미지 자연 크기 확보(=frame 크기 산출 기준). src 적용 후 load 시 1회 기록.
  overlayEls.img.addEventListener('load', () => {
    state.naturalW = overlayEls.img.naturalWidth || 0;
    state.naturalH = overlayEls.img.naturalHeight || 0;
    applyState();
  });

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

  // ---- 직접 상호작용: 이동 / 리사이즈(8핸들) / 회전(상단 핸들) ----
  // 단일 제스처 상태로 통합. type: 'move' | 'resize' | 'rotate'
  let gesture = null;

  // frame 중심의 화면 좌표(크기와 무관: top/left 50% + translate(-50%,-50%) 기준).
  function center() {
    return { x: window.innerWidth / 2 + state.x, y: window.innerHeight / 2 + state.y };
  }

  // 제스처 종료: mouseup 과 mousemove 가드에서 공유.
  function endGesture() {
    if (!gesture) return;
    gesture = null;
    applyState(); // 커서 복귀 등
  }

  // 이동: 이미지 본체 드래그.
  overlayEls.img.addEventListener('mousedown', (e) => {
    if (state.mode !== 'image' || !state.visible) return;
    e.preventDefault();
    gesture = { type: 'move', startX: e.clientX, startY: e.clientY, origX: state.x, origY: state.y };
    overlayEls.img.style.cursor = 'grabbing';
  });

  // 리사이즈: 꼭짓점·모서리 8개 핸들. 반대편을 고정하고 비율을 유지한다.
  for (const def of overlayEls.HANDLE_DEFS) {
    overlayEls.handles[def.id].addEventListener('mousedown', (e) => {
      if (state.mode !== 'image' || !state.visible) return;
      e.preventDefault();
      e.stopPropagation();
      const theta = state.rotation || 0;
      const s0 = T.clampScale(state.scale ?? 1);
      const hw0 = (state.naturalW * s0) / 2;
      const hh0 = (state.naturalH * s0) / 2;
      const C0 = center();
      // 반대편 앵커(로컬) → 화면 좌표(드래그 동안 고정).
      const rav = T.rotateVec(-def.sx * hw0, -def.sy * hh0, theta);
      gesture = {
        type: 'resize',
        sx: def.sx,
        sy: def.sy,
        theta,
        anchorX: C0.x + rav.x,
        anchorY: C0.y + rav.y,
      };
    });
  }

  function applyResize(e) {
    const { sx, sy, theta, anchorX, anchorY } = gesture;
    const nW = state.naturalW;
    const nH = state.naturalH;
    if (!nW || !nH) return;
    // 마우스를 앵커 기준 로컬 좌표로 역회전.
    const v = T.rotateVec(e.clientX - anchorX, e.clientY - anchorY, -theta);
    let newScale;
    if (sx !== 0 && sy !== 0) {
      // 꼭짓점: 두 축 비율 중 큰 값(커서를 따라 비율 유지 확대).
      newScale = Math.max((sx * v.x) / nW, (sy * v.y) / nH);
    } else if (sy === 0) {
      // 좌/우 모서리: 가로 기준(세로는 비율 따라감).
      newScale = (sx * v.x) / nW;
    } else {
      // 상/하 모서리: 세로 기준.
      newScale = (sy * v.y) / nH;
    }
    // 클램프 + 최소 픽셀 보장.
    const minScale = T.MIN_PX / Math.min(nW, nH);
    newScale = T.clampScale(Math.max(newScale, minScale));

    const hw = (nW * newScale) / 2;
    const hh = (nH * newScale) / 2;
    // 앵커가 고정되도록 새 중심: newCenter = anchor + R(θ)·(sx·hw, sy·hh).
    const off = T.rotateVec(sx * hw, sy * hh, theta);
    state.x = anchorX + off.x - window.innerWidth / 2;
    state.y = anchorY + off.y - window.innerHeight / 2;
    state.scale = newScale;
    applyState();
  }

  // 회전: 상단 회전 핸들. 중심 기준 각도 변화량을 더한다(스냅 없이 정밀).
  overlayEls.rotHandle.addEventListener('mousedown', (e) => {
    if (state.mode !== 'image' || !state.visible) return;
    e.preventDefault();
    e.stopPropagation();
    const C = center();
    gesture = {
      type: 'rotate',
      cx: C.x,
      cy: C.y,
      startRotation: state.rotation || 0,
      startAngle: Math.atan2(e.clientY - C.y, e.clientX - C.x),
    };
  });

  function applyRotate(e) {
    const { cx, cy, startRotation, startAngle } = gesture;
    const a = Math.atan2(e.clientY - cy, e.clientX - cx);
    const deltaDeg = ((a - startAngle) * 180) / Math.PI;
    state.rotation = T.normalizeRotation(startRotation + deltaDeg);
    applyState();
  }

  window.addEventListener(
    'mousemove',
    (e) => {
      if (!gesture) return;
      // 제스처 도중 모드가 바뀌거나(Ctrl 떼기·blur 등) 이미지가 사라지면 즉시 종료.
      if (state.mode !== 'image' || !state.visible) {
        endGesture();
        return;
      }
      if (gesture.type === 'move') {
        state.x = gesture.origX + (e.clientX - gesture.startX);
        state.y = gesture.origY + (e.clientY - gesture.startY);
        applyState();
      } else if (gesture.type === 'resize') {
        applyResize(e);
      } else if (gesture.type === 'rotate') {
        applyRotate(e);
      }
    },
    true
  );
  window.addEventListener('mouseup', endGesture, true);

  // ---- 직접 상호작용: 휠 줌(커서 기준) / Shift+휠 회전 ----
  overlayEls.img.addEventListener(
    'wheel',
    (e) => {
      if (state.mode !== 'image' || !state.visible) return;
      e.preventDefault(); // 페이지 스크롤 및 Ctrl+휠 페이지 줌 차단

      if (e.shiftKey) {
        const delta = e.deltaY > 0 ? -1 : 1;
        state.rotation = T.normalizeRotation(state.rotation + delta);
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
