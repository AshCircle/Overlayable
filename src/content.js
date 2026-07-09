// content.js — 진입점. 상태 단일 소스를 두고, 오버레이/패널을 주입하며,
// 키·모드 상태와 직접 상호작용(드래그/휠), 툴바 토글 메시지를 처리한다.
// 다중 사진: state.photos[] + selectedId 로 관리하고, 사진별 프레임을 frames Map 으로 reconcile.
// 로드 순서: transform.js, overlay.js, panel.js 다음 (가장 마지막).
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  if (NS.mounted) return; // 중복 주입 방지
  NS.mounted = true;

  const T = NS.transform;

  // 조작 모드 홀드 키: macOS 는 Command(Meta), 그 외는 Control.
  // macOS 에서 Ctrl+클릭은 OS 가 우클릭(contextmenu)으로 매핑해 조작과 충돌하므로 Command 를 쓴다.
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const MODE_KEY = IS_MAC ? 'Meta' : 'Control';

  // ---- 상태 (단일 소스) ----
  // photo: { id, name, src, x, y, scale, rotation, opacity, naturalW, naturalH }
  const state = {
    active: false, // 툴바 토글로 켜진 UI 표시 여부
    mode: 'web', // 'web' | 'image' (전역)
    photos: [], // 사진 배열 (배열 순서 = z-order, 뒤가 위)
    selectedId: null, // 현재 선택된 사진 id
  };
  let nextId = 1;

  // ---- 사진 헬퍼 ----
  function getPhoto(id) {
    return state.photos.find((p) => p.id === id) || null;
  }
  function getSelected() {
    return state.selectedId != null ? getPhoto(state.selectedId) : null;
  }

  // ---- DOM 주입 ----
  const container = NS.overlay.createContainer();
  // 사진 id → { frame, img, handles, handleEls, rotHandle }
  const frames = new Map();

  const root = document.createElement('div');
  root.className = 'imgovl-root';
  root.appendChild(container);

  // 패널 핸들러: 컨트롤 → state 갱신 → applyState. 모두 선택된 사진 대상.
  const panelApi = NS.panel.create({
    onUpload: (file) => addPhoto(file),
    onSelect: (id) => {
      state.selectedId = id;
      applyState();
    },
    onDelete: (id) => removePhoto(id),
    onOpacity: (pct) => withSelected((p) => (p.opacity = T.clamp(pct / 100, 0, 1))),
    onScale: (pct) => withSelected((p) => (p.scale = T.clampScale(pct / 100))),
    onScaleStep: (delta) =>
      withSelected((p) => (p.scale = T.clampScale(T.round(p.scale + delta, 4)))),
    onRotation: (deg) => withSelected((p) => (p.rotation = T.clampRotation(deg))),
    onRotateStep: (delta) => withSelected((p) => (p.rotation = T.clampRotation(p.rotation + delta))),
    onReset: () =>
      withSelected((p) => {
        resetTransform(p);
        p.opacity = 1;
      }),
    onRemove: () => {
      if (state.selectedId != null) removePhoto(state.selectedId);
    },
  });
  root.appendChild(panelApi.panel);

  document.documentElement.appendChild(root);

  // 선택된 사진이 있을 때만 변형을 적용하고 반영.
  function withSelected(fn) {
    const p = getSelected();
    if (!p) return;
    fn(p);
    applyState();
  }

  // ---- 상태 → DOM 반영 (단일 지점) ----
  function applyState() {
    root.style.display = state.active ? 'block' : 'none';
    reconcileFrames();
    const imageMode = state.mode === 'image';
    for (const p of state.photos) {
      const els = frames.get(p.id);
      if (els) NS.overlay.applyFrame(els, p, { imageMode, selected: p.id === state.selectedId });
    }
    panelApi.sync(state);
  }

  // photos 배열에 맞춰 프레임을 생성/제거하고 z-order(배열 순서)대로 정렬한다.
  function reconcileFrames() {
    // 제거: photos 에 없는 프레임.
    for (const [id, els] of frames) {
      if (!getPhoto(id)) {
        els.frame.remove();
        frames.delete(id);
      }
    }
    // 생성 + 순서 정렬: photos 순서대로 컨테이너에 append(이미 있으면 재배치).
    for (const p of state.photos) {
      let els = frames.get(p.id);
      if (!els) {
        els = NS.overlay.createFrame();
        frames.set(p.id, els);
        bindFrameEvents(p.id, els);
      }
      container.appendChild(els.frame); // append = 맨 뒤로 이동(배열 순서 유지)
    }
  }

  function resetTransform(p) {
    p.x = 0;
    p.y = 0;
    p.scale = 1;
    p.rotation = 0;
  }

  // ---- 사진 추가/제거 (objectURL 수명 관리) ----
  function addPhoto(file) {
    const photo = {
      id: nextId++,
      name: file.name || '이미지',
      src: URL.createObjectURL(file),
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      naturalW: 0, // load 이벤트 전까지는 숨김(naturalW>0 조건)
      naturalH: 0,
    };
    state.photos.push(photo);
    state.selectedId = photo.id; // 업로드한 사진을 자동 선택
    if (!state.active) state.active = true; // 업로드 시 자동으로 UI 표시
    applyState();
  }

  function removePhoto(id) {
    const p = getPhoto(id);
    if (!p) return;
    if (gesture && gesture.photoId === id) endGesture(); // 조작 중인 사진이면 제스처 정리
    if (p.src) URL.revokeObjectURL(p.src);
    state.photos = state.photos.filter((q) => q.id !== id);
    if (state.selectedId === id) {
      // 마지막(최상단) 사진을 새 선택으로, 없으면 해제.
      const last = state.photos[state.photos.length - 1];
      state.selectedId = last ? last.id : null;
    }
    applyState();
  }

  // ---- 사진별 직접 상호작용 바인딩 ----
  // 이미지 자연 크기 확보(=frame 크기 산출 기준). src 적용 후 load 시 1회 기록.
  function bindFrameEvents(id, els) {
    els.img.addEventListener('load', () => {
      const p = getPhoto(id);
      if (!p) return;
      p.naturalW = els.img.naturalWidth || 0;
      p.naturalH = els.img.naturalHeight || 0;
      applyState();
    });

    // 이동: 이미지 본체 드래그. 커서 아래(최상단) 사진을 자동 선택.
    els.img.addEventListener('mousedown', (e) => {
      const p = getPhoto(id);
      if (state.mode !== 'image' || !p || !(p.naturalW > 0)) return;
      e.preventDefault();
      state.selectedId = id;
      gesture = {
        type: 'move',
        photoId: id,
        startX: e.clientX,
        startY: e.clientY,
        origX: p.x,
        origY: p.y,
      };
      // host 의 img { cursor: ... !important } 를 이기도록 inline !important 로 고정.
      els.img.style.setProperty('cursor', 'grabbing', 'important');
      applyState();
    });

    // 리사이즈: 꼭짓점·모서리 8개 핸들. 반대편을 고정하고 비율을 유지한다.
    for (const def of NS.overlay.HANDLE_DEFS) {
      els.handles[def.id].addEventListener('mousedown', (e) => {
        const p = getPhoto(id);
        if (state.mode !== 'image' || !p || !(p.naturalW > 0)) return;
        e.preventDefault();
        e.stopPropagation();
        state.selectedId = id;
        const theta = p.rotation || 0;
        const s0 = T.clampScale(p.scale ?? 1);
        const hw0 = (p.naturalW * s0) / 2;
        const hh0 = (p.naturalH * s0) / 2;
        const C0 = center(p);
        // 반대편 앵커(로컬) → 화면 좌표(드래그 동안 고정).
        const rav = T.rotateVec(-def.sx * hw0, -def.sy * hh0, theta);
        gesture = {
          type: 'resize',
          photoId: id,
          sx: def.sx,
          sy: def.sy,
          theta,
          anchorX: C0.x + rav.x,
          anchorY: C0.y + rav.y,
        };
      });
    }

    // 회전: 상단 회전 핸들. 중심 기준 각도 변화량을 더한다(스냅 없이 정밀).
    els.rotHandle.addEventListener('mousedown', (e) => {
      const p = getPhoto(id);
      if (state.mode !== 'image' || !p || !(p.naturalW > 0)) return;
      e.preventDefault();
      e.stopPropagation();
      state.selectedId = id;
      const C = center(p);
      gesture = {
        type: 'rotate',
        photoId: id,
        cx: C.x,
        cy: C.y,
        startRotation: p.rotation || 0,
        startAngle: Math.atan2(e.clientY - C.y, e.clientX - C.x),
      };
    });

    // 휠 줌(커서 기준) / Shift+휠 회전. 커서가 올라간 사진을 선택.
    els.img.addEventListener(
      'wheel',
      (e) => {
        const p = getPhoto(id);
        if (state.mode !== 'image' || !p || !(p.naturalW > 0)) return;
        e.preventDefault(); // 페이지 스크롤 및 Ctrl+휠 페이지 줌 차단
        state.selectedId = id;

        if (e.shiftKey) {
          p.rotation = T.normalizeRotation(p.rotation + (e.deltaY > 0 ? -1 : 1));
          applyState();
          return;
        }

        const oldScale = p.scale;
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = T.clampScale(oldScale * factor);
        if (newScale === oldScale) {
          applyState(); // 선택 변경만이라도 반영
          return;
        }

        // 커서 위치 기준 줌: 커서 아래 지점이 고정되도록 x/y 보정 (회전 0 기준 근사).
        const ratio = newScale / oldScale;
        const cx = window.innerWidth / 2 + p.x; // 이미지 중심의 화면 x
        const cy = window.innerHeight / 2 + p.y; // 이미지 중심의 화면 y
        p.x = e.clientX - ratio * (e.clientX - cx) - window.innerWidth / 2;
        p.y = e.clientY - ratio * (e.clientY - cy) - window.innerHeight / 2;
        p.scale = newScale;
        applyState();
      },
      { capture: true, passive: false }
    );
  }

  // ---- 모드 전환 (MODE_KEY 홀드: macOS=Command, 그 외=Ctrl) ----
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    // image 모드를 벗어나면 잔존 제스처를 즉시 종료(다음 mousemove까지 미루지 않음).
    // blur/visibilitychange 는 모두 setMode('web') 을 경유하므로 여기서 일괄 정리된다.
    if (mode !== 'image') endGesture();
    applyState();
  }

  // capture 단계에서 받아 host 페이지 핸들러와의 충돌을 줄인다.
  // keydown/keyup 에서 preventDefault 하지 않아 브라우저 단축키(Cmd/Ctrl+C 등)는 그대로 동작.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === MODE_KEY) setMode('image');
    },
    true
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.key === MODE_KEY) setMode('web');
    },
    true
  );
  // stuck 방지: 탭 전환/포커스 상실 시 keyup 유실 대비.
  window.addEventListener('blur', () => setMode('web'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setMode('web');
  });

  // ---- 직접 상호작용: 이동 / 리사이즈(8핸들) / 회전(상단 핸들) ----
  // 단일 제스처 상태로 통합. type: 'move' | 'resize' | 'rotate', photoId: 대상 사진.
  let gesture = null;

  // frame 중심의 화면 좌표(크기와 무관: top/left 50% + translate(-50%,-50%) 기준).
  function center(p) {
    return { x: window.innerWidth / 2 + p.x, y: window.innerHeight / 2 + p.y };
  }

  // 제스처 종료: mouseup 과 mousemove 가드에서 공유.
  function endGesture() {
    if (!gesture) return;
    gesture = null;
    applyState(); // 커서 복귀 등
  }

  function applyResize(e, p) {
    const { sx, sy, theta, anchorX, anchorY } = gesture;
    const nW = p.naturalW;
    const nH = p.naturalH;
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
    p.x = anchorX + off.x - window.innerWidth / 2;
    p.y = anchorY + off.y - window.innerHeight / 2;
    p.scale = newScale;
    applyState();
  }

  function applyRotate(e, p) {
    const { cx, cy, startRotation, startAngle } = gesture;
    const a = Math.atan2(e.clientY - cy, e.clientX - cx);
    const deltaDeg = ((a - startAngle) * 180) / Math.PI;
    p.rotation = T.normalizeRotation(startRotation + deltaDeg);
    applyState();
  }

  window.addEventListener(
    'mousemove',
    (e) => {
      if (!gesture) return;
      const p = getPhoto(gesture.photoId);
      // 1차 종료는 setMode/removePhoto 가 담당. 여기는 혹시 모를 상태 불일치를 막는 안전망.
      if (state.mode !== 'image' || !p || !(p.naturalW > 0)) {
        endGesture();
        return;
      }
      if (gesture.type === 'move') {
        p.x = gesture.origX + (e.clientX - gesture.startX);
        p.y = gesture.origY + (e.clientY - gesture.startY);
        applyState();
      } else if (gesture.type === 'resize') {
        applyResize(e, p);
      } else if (gesture.type === 'rotate') {
        applyRotate(e, p);
      }
    },
    true
  );
  window.addEventListener('mouseup', endGesture, true);

  // image 모드에서는 이미지 조작이 우선이므로 우클릭 컨텍스트 메뉴를 차단한다.
  // (macOS 는 Command 홀드로 진입하므로 Ctrl+클릭 우클릭 매핑과는 무관하지만,
  //  조작 중 실제 우클릭/두 손가락 탭이 끼어드는 것을 막는 안전망으로 유지한다.)
  // capture 단계에서 막아 host 페이지/브라우저 기본 동작보다 먼저 처리한다.
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (state.mode === 'image') e.preventDefault();
    },
    true
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
