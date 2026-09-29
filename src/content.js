// content.js — 진입점. 상태 단일 소스를 두고, 오버레이/패널을 주입하며,
// 키·모드 상태와 직접 상호작용(드래그/휠), 툴바 토글 메시지를 처리한다.
// 다중 사진: state.photos[] + selectedId 로 관리하고, 사진별 프레임을 frames Map 으로 reconcile.
// geojson.io 지도 동기화: MAIN world 의 bridge.js 가 postMessage 로 보내는 카메라 상태를 받아
// 지오-앵커(photo.geo)를 가진 사진의 x/y/scale/rotation 을 매 프레임 다시 유도한다.
// 수동 조작 직후에는 reanchorPhoto 로 새 위치/크기를 지도에 재고정한다.
// 로드 순서: transform.js, geo.js, overlay.js, panel.js 다음 (가장 마지막).
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  if (NS.mounted) return; // 중복 주입 방지
  NS.mounted = true;

  const T = NS.transform;
  const W = NS.workspace;

  // 조작 모드 홀드 키: macOS 는 Command(Meta), 그 외는 Control.
  // macOS 에서 Ctrl+클릭은 OS 가 우클릭(contextmenu)으로 매핑해 조작과 충돌하므로 Command 를 쓴다.
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const MODE_KEY = IS_MAC ? 'Meta' : 'Control';

  // ---- 상태 (단일 소스) ----
  // photo: { id, name, src, x, y, scale, rotation, opacity, naturalW, naturalH, geo }
  // geo: null | { lng, lat, zoom, bearing, scale, rotation }
  //   — 사진 중심의 지리 앵커 + 앵커 시점의 카메라(zoom/bearing)와 변형(scale/rotation).
  //     카메라가 움직이면 이 앵커에서 x/y/scale/rotation 을 다시 유도한다(syncFromCamera).
  const state = {
    active: false, // 툴바 토글로 켜진 UI 표시 여부
    mode: 'web', // 'web' | 'image' (전역)
    photos: [], // 사진 배열 (배열 순서 = z-order, 뒤가 위)
    selectedId: null, // 현재 선택된 사진 id
    mapLinked: false, // geojson.io 지도 연동 여부(브리지 카메라 첫 수신 시 true)
    nextId: 1, // 다음 사진 id (영속화되어 세션 간 id 충돌을 막는다)
    workspace: {
      baseUrl: 'http://localhost:8080', layers: [], layerId: null, revision: null,
      status: '백엔드 연결 필요', error: false, selectedFeature: null,
      pendingLayerId: null, switchPhase: '', selectedFeatures: [], defaultLocation: null,
      referenceSnapshots: [], referencePhotos: [], references: [], referenceRevisions: {},
      referenceLoading: false, transferCandidates: null, transferPreview: null,
    },
  };

  // ---- 사진 헬퍼 ----
  function getPhoto(id) {
    return visiblePhotos().find((p) => p.id === id) || null;
  }
  function visiblePhotos() { return [...state.workspace.referencePhotos, ...state.photos]; }
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
    // 슬라이더는 절대값 입력이므로 슬라이더 범위로 클램프. ±스텝은 상대 조작이라
    // 지도 줌으로 범위를 벗어난 scale 을 5 로 스냅시키지 않도록 하드 한계만 적용.
    onScale: (pct) => withSelected((p) => (p.scale = T.clampScale(pct / 100))),
    onScaleStep: (delta) =>
      withSelected((p) => (p.scale = T.clampScaleHard(T.round(p.scale + delta, 4)))),
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
    onExport: () => exportState(),
    onImport: (text) => importState(text),
    onConnect: (url, key) => connectWorkspace(url, key),
    onLayerSelect: (id) => selectLayer(id),
    onLayerCreate: (request) => createLayer(request),
    onLayerCopy: (request) => copyLayer(request),
    onLayerRename: (name) => renameLayer(name),
    onLayerDelete: (name) => deleteLayer(name),
    onVerticalConnect: () => verticalConnectFlow(),
    onFeatureSave: (properties) => patchSelectedFeature(properties),
    onGeoJSONExport: () => exportCurrentGeoJSON(),
    onLayerReload: () => reloadCurrentLayer(),
    onLocationsSave: (locations) => updateLocations(locations),
    onDefaultLocation: (key) => changeDefaultLocation(key),
    onClassifySelected: (key) => classifySelected(key),
    onReferenceAdd: (id) => addReferenceLayer(id),
    onReferenceRemove: (id) => removeReferenceLayer(id),
    onReferenceRefresh: () => refreshReferences(),
    onReferenceOpacity: (id, opacity) => setReferenceOpacity(id, opacity),
    onLineSave: (properties) => patchSelectedFeature(properties),
    onEndpointBind: (end, nodeId) => bindSelectedEndpoint(end, nodeId),
    onTransferCandidates: (id) => loadTransferCandidates(id),
    onTransferPreview: (selection) => previewTransfer(selection),
    onTransferExecute: () => executeTransfer(),
    onTransferSelectionChange: () => { state.workspace.transferPreview = null; panelApi.sync(state); },
  });
  root.appendChild(panelApi.panel);

  document.documentElement.appendChild(root);

  // 선택된 사진이 있을 때만 변형을 적용하고 반영. 수동 변경이므로 새 값으로 지도에 재고정.
  function withSelected(fn) {
    if (state.workspace.pendingLayerId != null) return;
    const p = getSelected();
    if (!p || p.readonly) return;
    fn(p);
    reanchorPhoto(p);
    applyState();
  }

  // ---- 영속화 (chrome.storage.local) ----
  // 저장은 applyState 단일 지점에서만 예약한다. 카메라 이동 경로는 applyFrames 만 부르므로
  // 지도 드래그로는 저장이 일어나지 않는다(geo 앵커가 불변이라 저장할 것도 없다).
  let saveTimer = null;
  let restoring = false; // 복원 중에는 저장 억제(복원값이 곧바로 되-저장되는 낭비 방지)
  function scheduleSave() {
    if (restoring) return;
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      NS.storage.save(state);
    }, 400);
  }

  // ---- 상태 → DOM 반영 (단일 지점) ----
  // reconcile(멤버십/순서)과 프레임 반영을 분리한다: 카메라 구동 경로(syncFromCamera)는
  // 사진 추가/삭제/순서를 바꾸지 않으므로 applyFrames 만 호출하는 것이 정확하고 싸다.
  function applyState() {
    reconcileFrames();
    applyFrames();
    panelApi.sync(state);
    scheduleSave();
  }

  function applyFrames() {
    root.style.display = state.active ? 'block' : 'none';
    const imageMode = state.mode === 'image';
    for (const p of visiblePhotos()) {
      const els = frames.get(p.id);
      if (els) NS.overlay.applyFrame(els, p, { imageMode: imageMode && !p.readonly, selected: p.id === state.selectedId });
    }
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
    // 생성 + 순서 정렬: photos 순서대로 배치하되, 이미 제자리면 DOM 을 건드리지 않는다
    // (appendChild 는 같은 위치여도 제거+삽입으로 처리되어 불필요한 churn 을 만든다).
    let cursor = null; // 직전에 자리를 확정한 frame
    for (const p of visiblePhotos()) {
      let els = frames.get(p.id);
      if (!els) {
        els = NS.overlay.createFrame();
        frames.set(p.id, els);
        bindFrameEvents(p.id, els);
      }
      const want = cursor ? cursor.nextSibling : container.firstChild;
      if (els.frame !== want) container.insertBefore(els.frame, want);
      cursor = els.frame;
    }
  }

  function resetTransform(p) {
    p.x = 0;
    p.y = 0;
    p.scale = 1;
    p.rotation = 0;
  }

  // ---- 사진 추가/제거 ----
  // 영속화·공유를 위해 objectURL 대신 base64 data URL 을 src 의 단일 표현으로 쓴다.
  // FileReader 로 바이트를 읽는 동안 src 는 빈 문자열이고, 완료되면 채워져 표시된다.
  function addPhoto(file) {
    if (state.workspace.pendingLayerId != null || workspaceBusy) return;
    if (currentLayer()?.kind === 'SHARED_PATHS') { setWorkspaceStatus('공용 경로에서는 참조 도면 추가를 사용하세요.'); return; }
    const photo = {
      id: state.nextId++,
      uid: crypto.randomUUID(), // import 병합 시 중복 식별용 안정 id
      name: file.name || '이미지',
      src: '', // FileReader 완료 시 base64 data URL 로 채움
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      naturalW: 0, // load 이벤트 전까지는 숨김(naturalW>0 조건)
      naturalH: 0,
      geo: null, // 지리 앵커 — 카메라가 있으면 아래에서 즉시 고정
    };
    state.photos.push(photo);
    state.selectedId = photo.id; // 업로드한 사진을 자동 선택
    if (!state.active) state.active = true; // 업로드 시 자동으로 UI 표시
    reanchorPhoto(photo); // 화면 중앙(x=y=0)에 해당하는 지리 좌표에 고정

    const reader = new FileReader();
    reader.onload = () => {
      if (getPhoto(photo.id) !== photo) return; // 읽는 도중 삭제되거나 층이 바뀐 경우
      photo.src = String(reader.result || '');
      applyState(); // src 채워짐 → 프레임 표시 + 저장 예약
      if (state.workspace.layerId != null) queueWorkspaceImageMutation(() => uploadWorkspacePhoto(file, photo));
    };
    reader.onerror = () => console.warn('[Overlayable] 이미지 읽기 실패:', file && file.name);
    reader.readAsDataURL(file);

    applyState(); // 목록/선택은 즉시 반영(이미지는 src 채워지면 표시)
  }

  function removePhoto(id) {
    if (state.workspace.pendingLayerId != null) return;
    const p = getPhoto(id);
    if (!p || p.readonly) return;
    if (state.workspace.layerId != null && p.remoteId) queueWorkspaceImageMutation(() => deleteWorkspacePhoto(p));
    if (gesture && gesture.photoId === id) endGesture(); // 조작 중인 사진이면 제스처 정리
    // 과거 세션의 blob: URL 잔재만 revoke(현재는 data URL 이라 revoke 불필요).
    if (typeof p.src === 'string' && p.src.startsWith('blob:')) URL.revokeObjectURL(p.src);
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
      if (state.mode !== 'image' || !p || p.readonly || !(p.naturalW > 0)) return;
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
        if (state.mode !== 'image' || !p || p.readonly || !(p.naturalW > 0)) return;
        e.preventDefault();
        e.stopPropagation();
        state.selectedId = id;
        const theta = p.rotation || 0;
        // 렌더와 동일하게 raw scale 사용(지도 줌으로 슬라이더 범위를 벗어났어도 앵커가 안 튀도록).
        const s0 = Math.max(p.scale ?? 1, 0);
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
      if (state.mode !== 'image' || !p || p.readonly || !(p.naturalW > 0)) return;
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
        if (state.mode !== 'image' || !p || p.readonly || !(p.naturalW > 0)) return;
        e.preventDefault(); // 페이지 스크롤 및 Ctrl+휠 페이지 줌 차단
        state.selectedId = id;

        if (e.shiftKey) {
          p.rotation = T.normalizeRotation(p.rotation + (e.deltaY > 0 ? -1 : 1));
          reanchorPhoto(p);
          applyState();
          return;
        }

        const oldScale = p.scale;
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        // 상대 조작이므로 하드 한계만 적용(지도 줌으로 5 를 넘은 scale 이 스냅되지 않도록).
        const newScale = T.clampScaleHard(oldScale * factor);
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
        reanchorPhoto(p);
        applyState();
      },
      { capture: true, passive: false }
    );
  }

  // ---- 모드 전환 (MODE_KEY 홀드: macOS=Command, 그 외=Ctrl) ----
  function setMode(mode) {
    if (mode === 'image' && state.workspace.pendingLayerId != null) return;
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
    const p = getPhoto(gesture.photoId);
    gesture = null;
    // 제스처 동안 카메라 동기화에서 제외됐던 사진을 최종 위치로 재고정
    // (마지막 mousemove 이후 지도 관성 글라이드까지 흡수한다).
    reanchorPhoto(p);
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
    // 클램프(상대 조작 → 하드 한계) + 최소 픽셀 보장.
    const minScale = T.MIN_PX / Math.min(nW, nH);
    newScale = T.clampScaleHard(Math.max(newScale, minScale));

    const hw = (nW * newScale) / 2;
    const hh = (nH * newScale) / 2;
    // 앵커가 고정되도록 새 중심: newCenter = anchor + R(θ)·(sx·hw, sy·hh).
    const off = T.rotateVec(sx * hw, sy * hh, theta);
    p.x = anchorX + off.x - window.innerWidth / 2;
    p.y = anchorY + off.y - window.innerHeight / 2;
    p.scale = newScale;
    reanchorPhoto(p);
    applyState();
  }

  function applyRotate(e, p) {
    const { cx, cy, startRotation, startAngle } = gesture;
    const a = Math.atan2(e.clientY - cy, e.clientX - cx);
    const deltaDeg = ((a - startAngle) * 180) / Math.PI;
    p.rotation = T.normalizeRotation(startRotation + deltaDeg);
    reanchorPhoto(p);
    applyState();
  }

  window.addEventListener(
    'mousemove',
    (e) => {
      if (!gesture) return;
      const p = getPhoto(gesture.photoId);
      // 1차 종료는 setMode/removePhoto 가 담당. 여기는 혹시 모를 상태 불일치를 막는 안전망.
      if (state.mode !== 'image' || !p || p.readonly || !(p.naturalW > 0)) {
        endGesture();
        return;
      }
      if (gesture.type === 'move') {
        p.x = gesture.origX + (e.clientX - gesture.startX);
        p.y = gesture.origY + (e.clientY - gesture.startY);
        reanchorPhoto(p);
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

  // ---- geojson.io 지도 동기화 ----
  // camera: { lng, lat, zoom, bearing, cx, cy } — bridge.js 가 매 지도 프레임 postMessage 로 중계.
  // cx/cy 는 지리적 중심의 화면 px(패딩 반영). 지도를 못 찾으면 camera 는 null 로 남고
  // 사진은 기존처럼 화면 고정으로 동작한다.
  let camera = null;
  let cameraRafId = null;
  let panelSyncTimer = null;
  const bridgeRequests = new Map();

  // 수동 조작 직후 호출: 사진 중심의 화면 좌표를 지리 좌표로 역투영해 현재 카메라에 재고정.
  // project(unproject(pt)) 왕복이 정확히 일치하므로 재고정으로 화면 위치가 튀지 않는다.
  function reanchorPhoto(p) {
    if (!camera || !p) return;
    const ll = NS.geo.unproject(center(p), camera);
    p.geo = {
      lng: ll.lng,
      lat: ll.lat,
      zoom: camera.zoom,
      bearing: camera.bearing,
      scale: p.scale,
      rotation: p.rotation,
    };
  }

  // 카메라 → 사진 유도. 앵커에서 매번 다시 계산하고 unproject 를 쓰지 않으므로
  // 반복 왕복으로 인한 누적 드리프트가 없다.
  function syncFromCamera() {
    if (!camera) return;
    for (const p of visiblePhotos()) {
      // 제스처 중인 사진은 커서 추종이 우선(지도 관성 글라이드 중 드래그 대비). endGesture 가 재고정.
      if (gesture && gesture.photoId === p.id) continue;
      if (!p.geo) {
        reanchorPhoto(p); // 첫 카메라 수신: 현재 화면 위치 그대로 앵커(점프 없음)
        continue;
      }
      const pt = NS.geo.project(p.geo, camera);
      p.x = pt.x - window.innerWidth / 2;
      p.y = pt.y - window.innerHeight / 2;
      p.scale = p.geo.scale * Math.pow(2, camera.zoom - p.geo.zoom);
      p.rotation = T.normalizeRotation(p.geo.rotation - (camera.bearing - p.geo.bearing));
    }
    applyFrames(); // 멤버십/순서 불변 → reconcile 생략
    schedulePanelSync();
  }

  // 카메라 메시지는 지도 애니메이션 동안 매 프레임 오므로 rAF 로 병합해 프레임당 1회만 반영.
  function scheduleCameraSync() {
    if (cameraRafId != null) return;
    cameraRafId = requestAnimationFrame(() => {
      cameraRafId = null;
      syncFromCamera();
    });
  }

  // 패널 sync 는 목록/슬라이더 DOM 갱신 비용이 있어 카메라 경로에서는 최대 10Hz(trailing)로 제한.
  function schedulePanelSync() {
    if (panelSyncTimer != null) return;
    panelSyncTimer = setTimeout(() => {
      panelSyncTimer = null;
      panelApi.sync(state);
    }, 100);
  }

  window.addEventListener('message', (e) => {
    // 같은 창의 bridge.js 가 보낸 메시지만 수용하고 페이로드 숫자를 검증한다.
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'overlayable-bridge') return;
    if (d.type === 'geojson-state') {
      state.workspace.ownedPoints = (d.geojson?.features || []).filter((feature) => feature.geometry?.type === 'Point');
      state.workspace.selectedFeature = d.selectedFeature || null;
      state.workspace.selectedFeatures = d.selectedFeatures || (d.selectedFeature ? [d.selectedFeature] : []);
      const pending = d.requestId && bridgeRequests.get(d.requestId);
      if (pending) { bridgeRequests.delete(d.requestId); d.ready ? pending.resolve(d.geojson) : pending.reject(new Error('geojson.io 편집기를 찾지 못했습니다.')); }
      schedulePanelSync(); return;
    }
    if (d.type === 'geojson-error') {
      const pending = d.requestId && bridgeRequests.get(d.requestId);
      if (pending) { bridgeRequests.delete(d.requestId); pending.reject(new Error(d.message || 'geojson.io 연동 실패')); }
      return;
    }
    if (d.type === 'reference-error') { setWorkspaceStatus(`참조 표시 실패: ${d.message}`, true); return; }
    if (d.type !== 'camera') return;
    if (![d.lng, d.lat, d.zoom, d.bearing, d.cx, d.cy].every(Number.isFinite)) return;
    camera = { lng: d.lng, lat: d.lat, zoom: d.zoom, bearing: d.bearing, cx: d.cx, cy: d.cy };
    if (!state.mapLinked) {
      state.mapLinked = true;
      schedulePanelSync(); // 패널의 연동 상태 표시 갱신
    }
    scheduleCameraSync();
  });

  // 마운트 시 브리지에 카메라 재전송을 요청한다(지도가 idle 이어도 즉시 연동되도록.
  // 확장 리로드 시 MAIN world 브리지는 남아 있으므로 이 핑으로 재연결된다).
  window.postMessage({ source: 'overlayable-content', type: 'ping' }, location.origin);

  // 창 크기가 바뀌면 x/y(뷰포트 중심 기준)를 새 중심 기준으로 다시 유도한다.
  window.addEventListener('resize', scheduleCameraSync);

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

  // ---- 파일 export / import ----
  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // 현재 저장 상태를 JSON 파일로 내려받는다.
  function exportState() {
    const blob = NS.storage.toExportBlob(state);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `overlayable-${timestamp()}.json`;
    (document.body || document.documentElement).appendChild(a); // 클릭 위해 DOM 연결
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // 파일 텍스트를 파싱해 기존 오버레이에 병합(additive)한다. uid 가 같으면 중복으로 보고 건너뛴다.
  function importState(text) {
    if (state.workspace.pendingLayerId != null || workspaceBusy) return;
    if (currentLayer()?.kind === 'SHARED_PATHS') { setWorkspaceStatus('공용 경로에서는 참조 도면 추가를 사용하세요.'); return; }
    let records;
    try {
      records = NS.storage.parseImport(text);
    } catch (err) {
      alert(`가져오기 실패: ${err.message}`);
      return;
    }
    const existingUids = new Set(state.photos.map((p) => p.uid).filter(Boolean));
    let lastId = null;
    let added = 0;
    for (const rec of records) {
      if (rec.uid && existingUids.has(rec.uid)) continue; // 같은 파일 재-import 중복 방지
      const photo = {
        id: state.nextId++,
        uid: rec.uid || crypto.randomUUID(),
        name: rec.name,
        src: rec.src,
        x: rec.x,
        y: rec.y,
        scale: rec.scale,
        rotation: rec.rotation,
        opacity: rec.opacity,
        naturalW: rec.naturalW,
        naturalH: rec.naturalH,
        geo: rec.geo, // 위경도 앵커 — 다음 카메라 동기화가 화면 위치를 재계산
      };
      state.photos.push(photo);
      existingUids.add(photo.uid);
      lastId = photo.id;
      added++;
    }
    if (added === 0) {
      alert('이미 가져온 항목이라 추가된 이미지가 없습니다.');
      return;
    }
    state.active = true;
    if (lastId != null) state.selectedId = lastId;
    applyState();
    if (camera) scheduleCameraSync(); // geo 앵커를 현재 지도 위치로 즉시 투영
  }

  // ---- HongGwart layer workspace ----
  let workspaceBusy = false;
  let layerSwitchInFlight = null;
  let syncInFlight = null;
  let imageMutationQueue = Promise.resolve();
  let imageMutationBusy = false;
  let imageMutationError = null;
  let baselineHash = null;
  let syncTimer = null;
  // Session-only LRU, bounded by encoded string length. Never reuse unversioned content.
  const imageCache = new Map();
  const IMAGE_CACHE_LIMIT = 32 * 1024 * 1024;
  let imageCacheSize = 0;

  function setWorkspaceStatus(status, error = false) {
    state.workspace.status = status; state.workspace.error = error; panelApi.sync(state);
  }

  function showWorkspaceError(error) {
    const conflict = error && error.status === 409;
    setWorkspaceStatus(conflict
      ? '충돌: 다른 작업자가 변경했습니다. 로컬 편집은 유지됩니다. 레이어를 다시 불러오기 전에 GeoJSON을 내보내세요.'
      : `동기화 실패: ${error && error.message ? error.message : error}`, true);
  }

  function queueWorkspaceImageMutation(operation) {
    imageMutationQueue=imageMutationQueue.then(async()=>{imageMutationBusy=true;try{return await operation();}finally{imageMutationBusy=false;}})
      .catch((error)=>{imageMutationError=error;showWorkspaceError(error);});
    return imageMutationQueue;
  }

  function bridge(type, payload = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { bridgeRequests.delete(requestId); reject(new Error('geojson.io 응답 시간이 초과되었습니다.')); }, 5000);
      bridgeRequests.set(requestId, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
      window.postMessage({ source: 'overlayable-content', type, requestId, ...payload }, location.origin);
    });
  }

  async function exportCurrentGeoJSON() {
    try {
      const geojson=await bridge('geojson-read');
      const blob=new Blob([JSON.stringify(geojson,null,2)],{type:'application/geo+json'});
      const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url;
      const layer=state.workspace.layers.find((l)=>l.id===state.workspace.layerId);
      a.download=`${(layer?.name||'honggwart-layer').replace(/[^a-zA-Z0-9가-힣_-]+/g,'-')}-${timestamp()}.geojson`;
      (document.body||document.documentElement).appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(error){ showWorkspaceError(error); }
  }

  async function reloadCurrentLayer() {
    if (workspaceBusy) return;
    if(state.workspace.layerId==null) return;
    try { const response=await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/snapshot?protocolVersion=2`);
      await applyRemoteSnapshot(response.data); imageMutationError=null;
      setWorkspaceStatus(`원격 데이터 다시 불러옴 · revision ${response.data.revision}`);
    } catch(error){ showWorkspaceError(error); }
  }

  function transformPayload() {
    return state.photos.filter((p) => p.remoteId).map((p) => ({ id: p.remoteId,
      opacity: p.opacity, scale: p.scale, rotation: p.rotation, x: p.x, y: p.y,
      naturalWidth: p.naturalW, naturalHeight: p.naturalH, geo: p.geo || {} }));
  }

  function canonicalHash(geojson, images = transformPayload(), defaultLocation = state.workspace.defaultLocation) {
    return JSON.stringify({ geojson, defaultLocation: W.locationValue(defaultLocation), images: images.map(NS.transform.sharedImageTransform)
      .sort((a,b) => String(a.id).localeCompare(String(b.id))) });
  }

  async function connectWorkspace(url, key) {
    if (workspaceBusy) return;
    try {
      setWorkspaceStatus('연결 중…'); await NS.api.configure(url || 'http://localhost:8080', key || '');
      state.workspace.baseUrl = (url || 'http://localhost:8080').replace(/\/$/, '');
      await refreshLayers(); setWorkspaceStatus('연결됨 · 레이어를 선택하세요');
    } catch (error) { showWorkspaceError(error); }
  }

  async function refreshLayers() {
    const response = await NS.api.request('/api/admin/layers?protocolVersion=2');
    state.workspace.layers = response.data || []; panelApi.sync(state);
  }

  async function createLayer(request) {
    if (workspaceBusy) return;
    try {
      const response = await NS.api.request('/api/admin/layers', { method: 'POST', body: request });
      await refreshLayers(); await selectLayer(response.data.id);
    } catch (error) { showWorkspaceError(error); }
  }

  async function renameLayer(name) {
    if (workspaceBusy) return;
    if (state.workspace.layerId == null) return;
    try {
      const response = await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/name`, { method:'PUT',
        body:{ name, expectedRevision:state.workspace.revision, protocolVersion:2 } });
      state.workspace.revision=response.data.revision; await refreshLayers(); setWorkspaceStatus('레이어 이름 변경됨');
    } catch(error){ showWorkspaceError(error); }
  }

  async function copyLayer(request) {
    if (workspaceBusy) return;
    if (state.workspace.layerId == null) return;
    try {
      await syncNow(true);
      const response=await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/copy`, {method:'POST',
        body:{...request, expectedRevision:state.workspace.revision, protocolVersion:2}});
      await refreshLayers(); await selectLayer(response.data.id);
    } catch(error){ showWorkspaceError(error); }
  }

  async function deleteLayer(confirmationName) {
    if (workspaceBusy) return;
    if (state.workspace.layerId == null) return;
    try {
      await NS.api.request(`/api/admin/layers/${state.workspace.layerId}`, {method:'DELETE',
        body:{confirmationName, expectedRevision:state.workspace.revision, protocolVersion:2}});
      state.workspace.layerId=null; state.workspace.revision=null; baselineHash=null;
      clearReferences();
      state.photos=[]; state.selectedId=null;
      await bridge('geojson-replace',{geojson:{type:'FeatureCollection',features:[]}});
      await refreshLayers(); applyState(); setWorkspaceStatus('레이어가 삭제되었습니다.');
    } catch(error){ showWorkspaceError(error); }
  }

  function selectLayer(id) {
    if (workspaceBusy && !layerSwitchInFlight) return Promise.resolve();
    if (!layerSwitchInFlight && id === state.workspace.layerId) return Promise.resolve();
    state.workspace.pendingLayerId = id;
    panelApi.sync(state);
    if (layerSwitchInFlight) return layerSwitchInFlight;
    // Lock before the first await: autosync and repeated clicks cannot start a second switch.
    workspaceBusy = true;
    setMode('web');
    layerSwitchInFlight = switchToPendingLayer().catch(showWorkspaceError).finally(() => {
      workspaceBusy = false;
      layerSwitchInFlight = null;
      state.workspace.pendingLayerId = null;
      state.workspace.switchPhase = '';
      panelApi.sync(state);
    });
    return layerSwitchInFlight;
  }

  async function flushBeforeSwitch() {
    state.workspace.switchPhase = '현재 층 저장 확인 중…';
    panelApi.sync(state);
    await imageMutationQueue;
    if (imageMutationError) throw imageMutationError;
    if (state.workspace.layerId != null) await syncNow(true, { flushOnly: true });
  }

  async function switchToPendingLayer() {
    const legacyPhotos = state.workspace.layerId == null ? state.photos.filter((p)=>!p.remoteId && p.src?.startsWith('data:')) : [];
    let legacyDecisionPending = legacyPhotos.length > 0;
    await flushBeforeSwitch();
    while (state.workspace.pendingLayerId !== state.workspace.layerId) {
      const id = state.workspace.pendingLayerId;
      state.workspace.switchPhase = '도면 불러오는 중…';
      panelApi.sync(state);
      let snapshot, loaded;
      try {
        snapshot = (await NS.api.request(`/api/admin/layers/${id}/snapshot?protocolVersion=2`)).data;
        if (id !== state.workspace.pendingLayerId) continue;
        loaded = await loadSnapshotImages(snapshot);
      } catch (error) {
        // A failed obsolete request must not discard the user's newer selection.
        if (id !== state.workspace.pendingLayerId) continue;
        throw error;
      }
      if (id !== state.workspace.pendingLayerId) continue;
      // The map remains editable while downloading; flush edits made during that wait too.
      await flushBeforeSwitch();
      if (id !== state.workspace.pendingLayerId) continue;
      state.workspace.switchPhase = '지도에 적용 중…';
      panelApi.sync(state);
      const target = state.workspace.layers.find((layer) => layer.id === id);
      const importLegacy = legacyDecisionPending && target?.kind !== 'SHARED_PATHS'
        && confirm(`로컬에만 저장된 이미지 ${legacyPhotos.length}장을 선택한 레이어로 가져올까요?`);
      legacyDecisionPending = false;
      await applyRemoteSnapshot(snapshot, loaded);
      if (importLegacy) {
        for (const photo of legacyPhotos) await uploadLegacyPhoto(photo);
        const updated = await NS.api.request(`/api/admin/layers/${id}/snapshot?protocolVersion=2`);
        await applyRemoteSnapshot(updated.data);
      }
    }
    setWorkspaceStatus(`동기화됨 · revision ${state.workspace.revision}`);
  }

  async function imageSource(meta) {
    const key = meta.contentHash && JSON.stringify([state.workspace.baseUrl, meta.contentUrl, meta.contentHash, meta.contentType]);
    if (key && imageCache.has(key)) {
      const src = imageCache.get(key);
      imageCache.delete(key); imageCache.set(key, src);
      return src;
    }
    const content = await NS.api.request(meta.contentUrl, { responseType: 'base64' });
    const src = `data:${meta.contentType};base64,${content.data}`;
    if (key && src.length <= IMAGE_CACHE_LIMIT) {
      while (imageCacheSize + src.length > IMAGE_CACHE_LIMIT) {
        const oldest = imageCache.keys().next().value;
        imageCacheSize -= imageCache.get(oldest).length;
        imageCache.delete(oldest);
      }
      // Parallel references to the same image may finish together.
      if (imageCache.has(key)) imageCacheSize -= imageCache.get(key).length;
      imageCache.set(key, src); imageCacheSize += src.length;
    }
    return src;
  }

  function requireSnapshotV2(snapshot) {
    if (snapshot?.protocolVersion !== 2) throw new Error('백엔드 업데이트 필요(편집 프로토콜 v2)');
    return snapshot;
  }

  async function loadSnapshotImages(snapshot) {
    requireSnapshotV2(snapshot);
    return Promise.all((snapshot.images||[]).map(async(meta,index)=>{
      const src = await imageSource(meta);
      return { id:index+1, uid:meta.id, remoteId:meta.id, name:meta.name,
        src, x:meta.x, y:meta.y,
        scale:meta.scale, rotation:meta.rotation, opacity:meta.opacity,
        naturalW:meta.naturalWidth, naturalH:meta.naturalHeight,
        geo:meta.geo && Object.keys(meta.geo).length ? meta.geo : null };
    }));
  }

  async function applyRemoteSnapshot(snapshot, loaded, expectedHash) {
    requireSnapshotV2(snapshot);
    // Prepare all fallible network reads before replacing the currently displayed graph.
    if (!loaded) loaded = await loadSnapshotImages(snapshot);
    if (expectedHash != null && canonicalHash(await bridge('geojson-read')) !== expectedHash) return false;
    const editorGeoJSON=await bridge('geojson-replace',{geojson:snapshot.geojson});
    restoring=true;
    state.photos=loaded; state.nextId=loaded.length+1; state.selectedId=loaded.length?loaded[loaded.length-1].id:null;
    const changedLayer = state.workspace.layerId !== snapshot.layerId;
    if (changedLayer) {
      clearReferences();
      state.workspace.defaultLocation = null;
      state.workspace.transferPreview = null;
      state.workspace.transferCandidates = null;
    }
    state.workspace.layerId=snapshot.layerId; state.workspace.revision=snapshot.revision;
    state.workspace.references = snapshot.references || [];
    state.workspace.referenceRevisions = { ...(snapshot.referenceRevisions || {}) };
    const layerSummary=state.workspace.layers.find((layer)=>layer.id===snapshot.layerId);
    if(layerSummary) {
      layerSummary.revision=snapshot.revision;
      if (snapshot.kind) layerSummary.kind = snapshot.kind;
      if (snapshot.locations) layerSummary.locations = snapshot.locations;
      if (snapshot.requiresProtocolV2 != null) layerSummary.requiresProtocolV2 = snapshot.requiresProtocolV2;
      if (snapshot.defaultLocation) {
        layerSummary.defaultLocation = snapshot.defaultLocation;
        state.workspace.defaultLocation = W.locations(layerSummary).find((value) => W.locationKey(value) === W.locationKey(snapshot.defaultLocation)) || snapshot.defaultLocation;
      } else state.workspace.defaultLocation ||= layerSummary.defaultLocation || W.locations(layerSummary)[0] || null;
    }
    renderReferences();
    NS.api.setLastLayer(snapshot.layerId).catch(()=>{});
    restoring=false; applyState(); if(camera) scheduleCameraSync();
    baselineHash=canonicalHash(editorGeoJSON || snapshot.geojson,
      (snapshot.images||[]).map((m)=>({id:m.id,opacity:m.opacity,scale:m.scale,rotation:m.rotation,x:m.x,y:m.y,
        naturalWidth:m.naturalWidth,naturalHeight:m.naturalHeight,geo:m.geo||{}})));
    return true;
  }

  async function syncNow(force = false, { flushOnly = false } = {}) {
    if(((workspaceBusy || imageMutationBusy) && !force) || state.workspace.layerId == null) return;
    if (syncInFlight) {
      await syncInFlight;
      if (!flushOnly) return;
      // Re-read after an existing sync, so edits made while it ran are not skipped.
    }
    syncInFlight = (async () => {
      do {
        const geojson = await bridge('geojson-read');
        const localHash = canonicalHash(geojson);
        if (localHash !== baselineHash) {
          W.validateExternalVertices(geojson, state.workspace.referenceFeatures);
          setWorkspaceStatus('저장 중…');
          const response = await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/snapshot?protocolVersion=2`, {
            method: 'PUT',
            body: { expectedRevision: state.workspace.revision, protocolVersion: 2,
              geojson: W.withDefaults(geojson, state.workspace.defaultLocation, currentLayer()?.kind === 'SHARED_PATHS'),
              defaultLocation: W.locationValue(state.workspace.defaultLocation),
              referenceRevisions: referenceRevisions(geojson), images: transformPayload() },
          });
          // Apply normalized node/edge coordinates only if the saved version is still current.
          if (!await applyRemoteSnapshot(response.data, undefined, localHash)) {
            state.workspace.revision = response.data.revision;
            baselineHash = localHash;
            setWorkspaceStatus('추가 변경 저장 대기…');
            if (flushOnly) continue;
            return;
          }
          setWorkspaceStatus(`저장됨 · revision ${response.data.revision}`);
        } else if (!flushOnly) {
          const response = await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/snapshot?protocolVersion=2`);
          requireSnapshotV2(response.data);
          const dependenciesChanged = revisionHash(response.data.referenceRevisions) !== revisionHash(state.workspace.referenceRevisions);
          if (response.data.revision > state.workspace.revision || dependenciesChanged) {
            if (await applyRemoteSnapshot(response.data, undefined, localHash)) {
              setWorkspaceStatus(`원격 변경 반영 · revision ${response.data.revision}`);
            }
          } else setWorkspaceStatus(`동기화됨 · revision ${state.workspace.revision}`);
        }
        return;
      } while (flushOnly);
    })();
    try { return await syncInFlight; } finally { syncInFlight = null; }
  }

  function revisionHash(revisions) { return JSON.stringify(Object.entries(revisions || {}).sort(([a], [b]) => a.localeCompare(b))); }

  function currentLayer() { return state.workspace.layers.find((layer) => layer.id === state.workspace.layerId); }

  async function workspaceAction(operation) {
    if (workspaceBusy) return;
    workspaceBusy = true;
    state.workspace.operationBusy = true;
    panelApi.sync(state);
    try { await imageMutationQueue; if (imageMutationError) throw imageMutationError; await operation(); }
    catch (error) { showWorkspaceError(error); }
    finally { workspaceBusy = false; state.workspace.operationBusy = false; panelApi.sync(state); }
  }

  async function updateLocations(locations) {
    return workspaceAction(async () => {
      await syncNow(true, { flushOnly: true });
      const response = await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/locations`, {
        method: 'PUT', body: { expectedRevision: state.workspace.revision, locations, protocolVersion: 2 },
      });
      state.workspace.revision = response.data.revision;
      await refreshLayers();
      const available = W.locations(currentLayer());
      state.workspace.defaultLocation = available.find((x) => W.locationKey(x) === W.locationKey(state.workspace.defaultLocation))
        || available[0] || null;
      setWorkspaceStatus('허용 소속을 저장했습니다.');
    });
  }

  async function changeDefaultLocation(key) {
    return workspaceAction(async () => {
      // Save every existing draft with the OLD default before accepting the next one.
      await syncNow(true, { flushOnly: true });
      const location = W.locations(currentLayer()).find((value) => W.locationKey(value) === key);
      if (!location) throw new Error('등록된 소속을 선택하세요.');
      state.workspace.defaultLocation = location;
      await syncNow(true, { flushOnly: true });
      setWorkspaceStatus(`새 노드 소속: ${W.locationLabel(location)}`);
    });
  }

  async function classifySelected(key) {
    return workspaceAction(async () => {
      await bridge('geojson-read');
      const location = W.locations(currentLayer()).find((value) => W.locationKey(value) === key);
      if (!location) throw new Error('등록된 소속을 선택하세요.');
      const selected = state.workspace.selectedFeatures.filter((f) => f.geometry?.type === 'Point');
      if (!selected.length) throw new Error('소속을 변경할 Point를 선택하세요.');
      await bridge('geojson-update', { features: selected.map((feature) => ({ ...feature,
        properties: { ...feature.properties, location: W.locationValue(location) } })) });
      await syncNow(true, { flushOnly: true });
      setWorkspaceStatus(`${selected.length}개 노드의 소속을 변경했습니다.`);
    });
  }

  let referenceGeneration = 0;
  function clearReferences() {
    referenceGeneration++;
    state.workspace.referenceSnapshots = [];
    state.workspace.referencePhotos = [];
    state.workspace.references = [];
    state.workspace.referenceRevisions = {};
    state.workspace.referenceLoading = false;
    window.postMessage({ source: 'overlayable-content', type: 'references-set',
      geojson: { type: 'FeatureCollection', features: [] } }, location.origin);
  }

  function renderReferences() {
    const collection = W.referenceCollection(state.workspace.referenceSnapshots, state.workspace.references, state.workspace.referenceRevisions);
    state.workspace.referenceFeatures = collection.features;
    window.postMessage({ source: 'overlayable-content', type: 'references-set', geojson: collection }, location.origin);
  }

  function referenceRevisions(geojson) {
    const revisions = { ...state.workspace.referenceRevisions };
    const used = new Set((geojson?.features || []).flatMap((feature) =>
      (feature.properties?.overlayable?.vertexRefs || []).filter((ref) => ref?.nodeId != null).map((ref) => String(ref.ownerLayerId))));
    for (const snapshot of state.workspace.referenceSnapshots) {
      if (used.has(String(snapshot.layerId))) revisions[snapshot.layerId] = Math.max(revisions[snapshot.layerId] || 0, snapshot.revision);
    }
    return revisions;
  }

  async function addReferenceLayer(id, force = false) {
    if ((!force && workspaceBusy) || state.workspace.referenceLoading || state.workspace.layerId == null || id === state.workspace.layerId) return;
    const generation = referenceGeneration;
    state.workspace.referenceLoading = true; panelApi.sync(state);
    try {
      const snapshot = (await NS.api.request(`/api/admin/layers/${id}/snapshot?protocolVersion=2`)).data;
      const photos = await loadSnapshotImages(snapshot);
      if (generation !== referenceGeneration) return;
      state.workspace.referenceSnapshots = [...state.workspace.referenceSnapshots.filter((s) => s.layerId !== id), snapshot];
      state.workspace.referencePhotos = [...state.workspace.referencePhotos.filter((p) => p.referenceLayerId !== id),
        ...photos.map((photo) => ({ ...photo, id: `reference:${id}:${photo.remoteId}`,
          referenceLayerId: id, readonly: true }))];
      renderReferences(); applyState(); if (camera) scheduleCameraSync();
      setWorkspaceStatus('참조 도면·노드를 불러왔습니다. 참조 데이터는 읽기 전용입니다.');
    } catch (error) { if (generation === referenceGeneration) showWorkspaceError(error); }
    finally { if (generation === referenceGeneration) { state.workspace.referenceLoading = false; panelApi.sync(state); } }
  }

  function removeReferenceLayer(id) {
    if (state.workspace.referenceLoading) return;
    state.workspace.referenceSnapshots = state.workspace.referenceSnapshots.filter((s) => s.layerId !== id);
    state.workspace.referencePhotos = state.workspace.referencePhotos.filter((p) => p.referenceLayerId !== id);
    renderReferences(); applyState();
  }

  async function refreshReferences(force = false) {
    for (const snapshot of [...state.workspace.referenceSnapshots]) await addReferenceLayer(snapshot.layerId, force);
  }

  function setReferenceOpacity(id, value) {
    for (const photo of state.workspace.referencePhotos) if (photo.referenceLayerId === id) photo.opacity = value;
    applyFrames();
  }

  async function bindSelectedEndpoint(end, nodeId) {
    return workspaceAction(async () => {
      await bridge('geojson-read');
      const selected = state.workspace.selectedFeatures;
      if (selected.length !== 1 || selected[0].geometry?.type !== 'LineString') throw new Error('선 하나를 선택하세요.');
      const owned = nodeId == null ? null : state.workspace.ownedPoints?.find((f) => f.properties?.overlayable?.nodeId === nodeId);
      const reference = owned ? { ...owned, properties: { ...owned.properties, overlayable: { ...owned.properties.overlayable, ownerLayerId: state.workspace.layerId } } }
        : nodeId == null ? null : state.workspace.referenceFeatures?.find((f) => f.geometry?.type === 'Point' && f.properties?.overlayable?.nodeId === nodeId);
      if (nodeId != null && !reference) throw new Error('참조 노드를 다시 선택하세요.');
      const updated = W.bindEndpoint(selected[0], end, reference, state.workspace.layerId);
      await bridge('geojson-update', { features: [updated] });
      await syncNow(true, { flushOnly: true });
    });
  }

  async function loadTransferCandidates(layerId) {
    if (workspaceBusy) return;
    const owner = state.workspace.layerId;
    try {
      const response = await NS.api.request('/api/admin/graph-transfers/candidates' + (layerId == null ? '' : `?layerId=${layerId}`));
      if (owner !== state.workspace.layerId) return;
      state.workspace.transferCandidates = { ...response.data, sourceLayerId: layerId };
      state.workspace.transferPreview = null; panelApi.sync(state);
    } catch (error) { showWorkspaceError(error); }
  }

  async function previewTransfer(selection) {
    return workspaceAction(async () => {
      await syncNow(true, { flushOnly: true });
      const request = { targetLayerId: selection.targetLayerId, nodeIds: selection.nodeIds, edgeIds: selection.edgeIds };
      const response = await NS.api.request('/api/admin/graph-transfers/preview', { method: 'POST', body: request });
      state.workspace.transferPreview = { ...response.data, request };
      panelApi.sync(state);
      setWorkspaceStatus('이전 미리보기를 확인한 뒤 실행하세요. 아직 데이터는 변경되지 않았습니다.');
    });
  }

  async function executeTransfer() {
    const preview = state.workspace.transferPreview;
    if (!preview) return;
    return workspaceAction(async () => {
      await syncNow(true, { flushOnly: true });
      const localHash = canonicalHash(await bridge('geojson-read'));
      await NS.api.request('/api/admin/graph-transfers', { method: 'POST', body: { ...preview.request,
        expectedRevisions: preview.expectedRevisions, previewToken: preview.previewToken } });
      state.workspace.transferPreview = null;
      state.workspace.transferCandidates = null;
      await refreshLayers();
      const response = await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/snapshot?protocolVersion=2`);
      if (!await applyRemoteSnapshot(response.data, undefined, localHash)) {
        setWorkspaceStatus('이전은 완료됐지만 처리 중 추가 편집이 있습니다. GeoJSON을 내보낸 뒤 원격 데이터를 다시 불러오세요.', true);
        return;
      }
      await refreshReferences(true);
      setWorkspaceStatus('노드 ID를 유지하여 공용 경로로 이전했습니다.');
    });
  }

  async function patchSelectedFeature(properties) {
    return workspaceAction(async () => {
      await bridge('geojson-patch-selected', { properties });
      await syncNow(true, { flushOnly: true });
    });
  }

  async function verticalConnectFlow() {
    return workspaceAction(async () => {
      if (state.workspace.layerId == null) return;
      await syncNow(true, { flushOnly: true });
      await bridge('geojson-read');
      const feature = state.workspace.selectedFeature;
      const nodeId = feature?.properties?.overlayable?.nodeId;
      if (!nodeId || state.workspace.selectedFeatures.length !== 1 || feature.geometry?.type !== 'Point') {
        throw new Error('먼저 저장된 Point 하나를 선택하세요.');
      }
      if (!state.workspace.connectionDraft) {
        state.workspace.connectionDraft = { sourceNodeId: nodeId, sourceLayerId: state.workspace.layerId };
        setWorkspaceStatus('연결 시작점 저장됨 · 다른 층의 Point를 선택한 뒤 연결을 완료하세요.'); return;
      }
      const draft = state.workspace.connectionDraft;
      if (draft.sourceNodeId === nodeId) {
        state.workspace.connectionDraft = null; setWorkspaceStatus('층 연결을 취소했습니다.'); return;
      }
      const snapshot = requireSnapshotV2((await NS.api.request(`/api/admin/layers/${draft.sourceLayerId}/snapshot?protocolVersion=2`)).data);
      const source = snapshot.geojson.features.find((f) => f.geometry?.type === 'Point' && f.properties?.overlayable?.nodeId === draft.sourceNodeId);
      if (!source) throw new Error('시작 노드가 삭제되거나 이전되었습니다. 같은 시작점을 다시 선택해 취소하세요.');
      const transport = prompt('이동 수단: STAIR 또는 ELEVATOR', 'STAIR');
      if (transport == null) return;
      if (!['STAIR', 'ELEVATOR'].includes(transport)) throw new Error('STAIR 또는 ELEVATOR를 입력하세요.');
      const weightInput = prompt('이동 가중치(m)', '3'); if (weightInput == null) return;
      const weight = Number(weightInput); if (!Number.isFinite(weight) || weight <= 0) throw new Error('가중치는 양수여야 합니다.');
      const id = crypto.randomUUID();
      const sourceRef = draft.sourceLayerId === state.workspace.layerId
        ? { editorId: source.properties.overlayable.editorId }
        : { nodeId: draft.sourceNodeId, ownerLayerId: draft.sourceLayerId };
      state.workspace.referenceRevisions[draft.sourceLayerId] = snapshot.revision;
      const line = { type: 'Feature', id, properties: { edgeType: transport, indoor: true, bidirectional: true,
        weightMode: 'MANUAL', weights: [weight], overlayable: { kind: 'edge-chain', featureId: id,
          vertexRefs: [sourceRef, { editorId: feature.properties.overlayable.editorId }], segmentEdgeIds: [] } },
        geometry: { type: 'LineString', coordinates: [source.geometry.coordinates, feature.geometry.coordinates] } };
      await bridge('geojson-insert', { features: [line] });
      await syncNow(true, { flushOnly: true });
      state.workspace.connectionDraft = null;
      setWorkspaceStatus('현재 레이어 소유의 층간 연결을 저장했습니다.');
    });
  }

  async function uploadWorkspacePhoto(file, photo) {
    const base64=photo.src.slice(photo.src.indexOf(',')+1);
    const response=await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/images?expectedRevision=${state.workspace.revision}&protocolVersion=2`,
      {method:'POST',bodyType:'image-form',body:{base64,name:file.name||'image',contentType:file.type||'application/octet-stream'}});
    photo.remoteId=response.data.id; photo.uid=response.data.id; state.workspace.revision += 1; baselineHash=null;
    await syncNow(true);
  }

  async function uploadLegacyPhoto(photo) {
    if (currentLayer()?.kind === 'SHARED_PATHS') throw new Error('공용 경로에는 이미지를 업로드할 수 없습니다. 참조 도면을 추가하세요.');
    const comma=photo.src.indexOf(','); const header=photo.src.slice(0,comma);
    const contentType=(header.match(/^data:([^;]+)/)||[])[1]||'image/png';
    await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/images?expectedRevision=${state.workspace.revision}&protocolVersion=2`,
      {method:'POST',bodyType:'image-form',body:{base64:photo.src.slice(comma+1),name:photo.name||'image',contentType}});
    state.workspace.revision += 1;
  }

  async function deleteWorkspacePhoto(photo) {
    await NS.api.request(`/api/admin/layers/${state.workspace.layerId}/images/${photo.remoteId}?expectedRevision=${state.workspace.revision}&protocolVersion=2`,{method:'DELETE'});
    state.workspace.revision += 1; baselineHash=null;
  }

  async function bootstrapWorkspace() {
    try {
      const auth=await NS.api.settings(); state.workspace.baseUrl=auth.baseUrl;
      if(auth.hasApiKey) {
        await refreshLayers(); setWorkspaceStatus('연결됨 · 레이어를 선택하세요');
        if(auth.lastLayerId && state.workspace.layers.some((l)=>l.id===auth.lastLayerId)) await selectLayer(auth.lastLayerId);
      }
      else panelApi.sync(state);
    } catch(error){ showWorkspaceError(error); }
    syncTimer=setInterval(()=>syncNow().catch(showWorkspaceError),10000);
  }

  // ---- 자동 복원 ----
  async function restore() {
    const saved = await NS.storage.load();
    if (!saved || !Array.isArray(saved.photos) || saved.photos.length === 0) return;
    restoring = true;
    try {
      state.photos = saved.photos.map((p) => ({
        id: p.id,
        uid: p.uid || crypto.randomUUID(),
        remoteId: p.remoteId || null,
        name: p.name || '이미지',
        src: p.src,
        x: Number.isFinite(p.x) ? p.x : 0,
        y: Number.isFinite(p.y) ? p.y : 0,
        scale: Number.isFinite(p.scale) ? p.scale : 1,
        rotation: Number.isFinite(p.rotation) ? p.rotation : 0,
        opacity: Number.isFinite(p.opacity) ? p.opacity : 1,
        naturalW: Number.isFinite(p.naturalW) ? p.naturalW : 0,
        naturalH: Number.isFinite(p.naturalH) ? p.naturalH : 0,
        geo: p.geo || null,
      }));
      // id 충돌 방지: 저장된 nextId 와 현재 사진 최대 id+1 중 큰 값.
      const maxId = state.photos.reduce((m, p) => Math.max(m, p.id || 0), 0);
      state.nextId = Math.max(saved.nextId || 1, maxId + 1);
      state.selectedId =
        saved.selectedId != null && getPhoto(saved.selectedId)
          ? saved.selectedId
          : state.photos[state.photos.length - 1].id;
      state.active = true; // 복원된 오버레이는 바로 보이도록
    } finally {
      restoring = false;
    }
    applyState();
    if (camera) scheduleCameraSync(); // 이미 카메라를 받았다면 즉시 지도 위치로 투영
  }

  // 초기 반영 (active=false → 숨김 상태) 후, 저장된 상태를 비동기 복원.
  applyState();
  (async()=>{ await restore(); await bootstrapWorkspace(); })();
})();
