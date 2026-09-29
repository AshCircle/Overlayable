// bridge.js — MAIN world 에서 geojson.io 의 Mapbox GL 지도 인스턴스를 찾아,
// 카메라 상태(중심/줌/베어링 + 중심의 화면 px)를 window.postMessage 로
// 콘텐츠 스크립트(ISOLATED world 의 content.js)에 중계한다.
//
// 지도 발견 캐스케이드:
//  ① window.api.map — 구 geojson.io 가 API.md 로 공식 문서화한 전역
//  ② window.map    — 방어적 확인
//  ③ React fiber 탐색 — 신 코드베이스(Placemark 기반 React 18)는 전역 노출 없이
//     ref 안의 PMap.map 으로만 들고 있으므로, 지도 컨테이너의 fiber 트리를 뒤진다.
// 어느 것도 실패하면 경고 1회 후 느린 폴링으로 계속 재시도하고,
// content.js 는 카메라 미수신 상태에서 기존 화면 고정 동작을 유지한다(우아한 성능 저하).
//
// 주의: MAIN world 에서 실행되므로 chrome.* API 를 쓸 수 없고,
// ISOLATED world 의 window.__OVERLAYABLE__ 네임스페이스도 보이지 않는다(전혀 다른 JS 컨텍스트).
(function () {
  'use strict';

  if (window.__OVERLAYABLE_BRIDGE__) return; // 중복 주입 방지 (MAIN world 전용 플래그)
  window.__OVERLAYABLE_BRIDGE__ = true;

  // 진단 로그: 이 로그가 콘솔에 없으면 브리지가 주입되지 않은 것
  // (manifest 변경 후 chrome://extensions 에서 확장을 리로드하지 않은 경우가 대표적).
  console.info('[Overlayable] 브리지 로드됨 — geojson.io 지도 탐색 시작');

  let map = null;
  let pollTimer = null;
  let rectTimer = null;
  let lastRectKey = '';
  let attempts = 0;
  let editor = null; // { persistence, data }; discovered from React context/hooks
  let editorPersistence = null;
  let editorData = null;
  let editorDataSource = null;
  let editorTimer = null;
  let referenceGeoJSON = { type: 'FeatureCollection', features: [] };
  const REFERENCE_SOURCE = 'overlayable-reference-nodes';
  const REFERENCE_LAYER = 'overlayable-reference-nodes-circle';
  const REFERENCE_LINE = 'overlayable-reference-edges-line';
  let referenceErrorReported = false;
  let referenceKey = '', renderedReferenceKey = '', renderedReferenceSource = null;

  // 빠른 폴링(250ms × 40회 = 10초) → 실패 시 경고 1회 → 2초 간격으로 영구 재시도(SPA 늦은 마운트 대비).
  const FAST_MS = 250;
  const SLOW_MS = 2000;
  const FAST_LIMIT = 40;

  // ---- 지도 인스턴스 판별 ----
  // Mapbox GL Map 이 반드시 갖는 메서드들의 덕타이핑. 버전/번들링과 무관하게 동작한다.
  function isMapLike(o) {
    return !!(
      o &&
      typeof o.getCenter === 'function' &&
      typeof o.getZoom === 'function' &&
      typeof o.getBearing === 'function' &&
      typeof o.project === 'function' &&
      typeof o.on === 'function' &&
      typeof o.getContainer === 'function'
    );
  }

  // 후보가 지도 그 자체이거나, 지도를 .map 으로 감싼 래퍼(신 코드베이스의 PMap)여도 수용.
  function probe(o) {
    try {
      if (isMapLike(o)) return o;
      if (o && typeof o === 'object' && isMapLike(o.map)) return o.map;
    } catch (e) {
      // 게터가 던지는 이물 객체는 무시
    }
    return null;
  }

  // ---- 발견 캐스케이드 ----
  // 성공 시 { map, via } 를 반환해 attach() 가 발견 경로를 로그로 남길 수 있게 한다.
  function discover() {
    let m = null;
    try {
      m = probe(window.api && window.api.map);
      if (m) return { map: m, via: 'window.api.map' };
      m = probe(window.map);
      if (m) return { map: m, via: 'window.map' };
    } catch (e) {
      // 전역이 던지는 게터로 정의된 경우에도 폴링이 죽지 않게 무시
    }
    const containers = document.querySelectorAll('.mapboxgl-map');
    for (const el of containers) {
      m = findViaFiber(el);
      if (m) return { map: m, via: 'react-fiber' };
    }
    return null;
  }

  // React fiber 탐색: 컨테이너(또는 fiber 키를 가진 가장 가까운 조상 요소)의 __reactFiber$* 키에서
  // 시작해 조상(.return) 최대 20단계를 시드로 child/sibling BFS(방문 Set, 상한 5000).
  // 각 fiber 의 stateNode/ref/훅 상태/컨텍스트 의존성/props 를 얕게 probe.
  // React 내부 구조에 의존하는 폴백이므로 전체를 try/catch 로 감싼다(실패 시 다음 폴링에서 재시도).
  function findViaFiber(el) {
    try {
      // 컨테이너가 React 밖에서 생성된 경우(향후 배포 대비)에도 DOM 조상에서 fiber 를 찾는다.
      let host = el;
      let key = null;
      for (let up = 0; host && up < 10; up++) {
        key = Object.keys(host).find(
          (k) => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactContainer$') === 0
        );
        if (key) break;
        host = host.parentElement;
      }
      if (!host || !key) return null;

      const queue = [];
      let f = host[key];
      for (let i = 0; f && i < 20; i++) {
        queue.push(f);
        f = f.return;
      }

      const visited = new Set();
      let steps = 0;
      while (queue.length && steps < 5000) {
        const fiber = queue.shift();
        if (!fiber || visited.has(fiber)) continue;
        visited.add(fiber);
        steps++;

        const found = probeFiber(fiber);
        if (found) return found;

        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
    } catch (e) {
      // fiber 내부 구조 변화 등은 조용히 무시
    }
    return null;
  }

  function probeFiber(fiber) {
    discoverEditorValue(fiber.memoizedState);
    discoverEditorValue(fiber.memoizedProps);
    discoverEditorValue(fiber.dependencies);
    let m =
      probe(fiber.stateNode) ||
      probe(fiber.ref && fiber.ref.current) ||
      probe(fiber.memoizedState); // 클래스 컴포넌트: memoizedState = state 객체 그 자체
    if (m) return m;

    // 함수 컴포넌트: memoizedState 는 훅 연결 리스트. useRef(PMap) → hook.memoizedState.current.map 대응.
    let hook = fiber.memoizedState;
    for (let i = 0; hook && typeof hook === 'object' && i < 64; i++) {
      m = probe(hook.memoizedState);
      if (m) return m;
      const hs = hook.memoizedState;
      if (hs && typeof hs === 'object') {
        m = probe(hs.current);
        if (m) return m;
      }
      hook = hook.next;
    }

    // Context 소비자: 지도 래퍼가 React Context 로도 전파되는 것을 프로덕션 번들에서 확인.
    // useRef 경로가 막혀도 컨텍스트 의존성 체인의 memoizedValue 에서 잡힌다.
    try {
      let dep = fiber.dependencies && fiber.dependencies.firstContext;
      for (let i = 0; dep && i < 32; i++) {
        m = probe(dep.memoizedValue);
        if (m) return m;
        dep = dep.next;
      }
    } catch (e) {
      // 컨텍스트 내부 구조 변화는 무시
    }

    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      for (const k in props) {
        try {
          m = probe(props[k]);
        } catch (e) {
          continue; // 던지는 게터는 건너뜀
        }
        if (m) return m;
      }
    }
    return null;
  }

  // geojson.io does not expose a public editor API. Its current memory persistence
  // object and Jotai data value are reachable through React context/hook values.
  // Duck typing keeps a future internal change contained: sync is disabled while
  // camera/image overlay continues to work.
  function discoverEditorValue(root) {
    if (!root || typeof root !== 'object') return;
    const queue = [{ value: root, depth: 0 }];
    const seen = new Set();
    while (queue.length && seen.size < 800) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      try {
        // Jotai useAtomValue stores [value, store, atom] in its reducer hook.
        // Read the live store instead of stale React render/alternate snapshots.
        if (Array.isArray(value) && value[0]?.featureMap instanceof Map &&
            typeof value[1]?.get === 'function' && typeof value[2]?.read === 'function') {
          editorDataSource = { store: value[1], atom: value[2] };
        }
        if (typeof value.useTransact === 'function' && value.idMap) editorPersistence = value;
        if (value.featureMap instanceof Map && value.selection) editorData = value;
      } catch (_) {}
      if (depth >= 4) continue;
      let values = [];
      try {
        if (Array.isArray(value)) values = value.slice(0, 40);
        else for (const key of Object.keys(value).slice(0, 60)) values.push(value[key]);
      } catch (_) {}
      for (const child of values) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
    // Context and data live on different fibers; retain each discovery separately.
    if (editorPersistence && editorData) editor = { persistence: editorPersistence, data: editorData };
  }

  function refreshEditor() {
    if (editorDataSource && editorPersistence) {
      editor = { persistence: editorPersistence, data: editorDataSource.store.get(editorDataSource.atom) };
      postGeoJSON();
      return;
    }
    const containers = document.querySelectorAll('.mapboxgl-map');
    for (const el of containers) scanFiberForEditor(el);
    if (editorDataSource && editorPersistence) {
      editor = { persistence: editorPersistence, data: editorDataSource.store.get(editorDataSource.atom) };
    }
    if (editor) postGeoJSON();
  }

  function scanFiberForEditor(el) {
    try {
      let host=el, key=null;
      for(let up=0;host&&up<10;up++) { key=Object.keys(host).find((k)=>k.indexOf('__reactFiber$')===0||k.indexOf('__reactContainer$')===0); if(key) break; host=host.parentElement; }
      if(!host||!key) return;
      const queue=[]; let seed=host[key]; for(let i=0;seed&&i<25;i++){queue.push(seed);seed=seed.return;}
      const seen=new Set();
      while(queue.length&&seen.size<12000){const fiber=queue.shift();if(!fiber||seen.has(fiber))continue;seen.add(fiber);
        discoverEditorValue(fiber.memoizedState);discoverEditorValue(fiber.memoizedProps);discoverEditorValue(fiber.dependencies);
        if(fiber.child)queue.push(fiber.child);if(fiber.sibling)queue.push(fiber.sibling);}
    } catch(_) {}
  }

  function featureCollection() {
    if (!editor || !(editor.data.featureMap instanceof Map)) return null;
    return { type: 'FeatureCollection', features: Array.from(editor.data.featureMap.values(), (wrapped) => wrapped.feature) };
  }

  function selectedFeature() {
    return selectedFeatures()[0] || null;
  }

  function selectedFeatures() {
    if (!editor) return [];
    const selection = editor.data.selection;
    const ids = selection?.ids || (selection?.id ? [selection.id] : []);
    return ids.map((id) => {
      const wrapped = editor.data.featureMap.get(id);
      if (!wrapped?.feature) return null;
      return wrapped.feature.id != null ? wrapped.feature : { ...wrapped.feature, id: wrapped.id ?? id };
    }).filter(Boolean);
  }

  function postGeoJSON(requestId) {
    const geojson = featureCollection();
    window.postMessage({ source: 'overlayable-bridge', type: 'geojson-state', requestId,
      ready: !!geojson, geojson, selectedFeature: selectedFeature(), selectedFeatures: selectedFeatures() }, location.origin);
  }

  async function replaceGeoJSON(geojson, requestId) {
    refreshEditor();
    if (!editor || !geojson || !Array.isArray(geojson.features)) throw new Error('geojson.io 편집기를 찾지 못했습니다.');
    const oldIds = Array.from(editor.data.featureMap.keys());
    const seen = new Set();
    const putFeatures = geojson.features.map((feature) => {
      let id = typeof feature.id === 'string' && /^[0-9a-f-]{36}$/i.test(feature.id) ? feature.id : crypto.randomUUID();
      while (seen.has(id)) id = crypto.randomUUID();
      seen.add(id);
      feature = { ...feature, id };
      return { id, feature };
    });
    await editor.persistence.useTransact()({ note: 'Loaded HongGwart layer', deleteFeatures: oldIds, putFeatures });
    setTimeout(() => { refreshEditor(); postGeoJSON(requestId); }, 0);
  }

  async function patchSelected(properties, requestId) {
    refreshEditor();
    if (!editor) throw new Error('geojson.io 편집기를 찾지 못했습니다.');
    const selection = editor.data.selection;
    const id = selection && (selection.id || (selection.ids && selection.ids[0]));
    const wrapped = id && editor.data.featureMap.get(id);
    if (selectedFeatures().length !== 1 || !wrapped || !['Point', 'LineString'].includes(wrapped.feature.geometry?.type)) {
      throw new Error('Point 또는 선 하나를 선택하세요.');
    }
    await editor.persistence.useTransact()({ note: 'Edited HongGwart node', deleteFeatures: [],
      putFeatures: [{ ...wrapped, feature: { ...wrapped.feature, properties: { ...(wrapped.feature.properties || {}), ...properties } } }] });
    setTimeout(() => { refreshEditor(); postGeoJSON(requestId); }, 0);
  }

  async function updateFeatures(features, requestId, allowInsert = false) {
    refreshEditor();
    if (!editor || !Array.isArray(features)) throw new Error('geojson.io 편집기를 찾지 못했습니다.');
    const putFeatures = features.map((feature) => {
      const wrapped = editor.data.featureMap.get(feature.id)
        || Array.from(editor.data.featureMap.values()).find((value) => value.feature?.id === feature.id);
      if (!wrapped && !allowInsert) throw new Error('선택 지형지물이 변경되었습니다. 다시 선택하세요.');
      return { ...(wrapped || { id: feature.id }), feature };
    });
    await editor.persistence.useTransact()({ note: 'Edited HongGwart graph', deleteFeatures: [], putFeatures });
    setTimeout(() => { refreshEditor(); postGeoJSON(requestId); }, 0);
  }

  function renderReferences() {
    if (!map) return;
    try {
      if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) return;
      if (!referenceGeoJSON.features.length) {
        if (map.getLayer?.(REFERENCE_LAYER)) map.removeLayer(REFERENCE_LAYER);
        if (map.getLayer?.(REFERENCE_LINE)) map.removeLayer(REFERENCE_LINE);
        if (map.getSource?.(REFERENCE_SOURCE)) map.removeSource(REFERENCE_SOURCE);
        renderedReferenceSource = null;
        return;
      }
      if (![map.addSource, map.addLayer, map.getSource, map.getLayer].every((method) => typeof method === 'function')) {
        throw new Error('현재 지도에서 읽기 전용 참조 표시를 지원하지 않습니다.');
      }
      const existing = map.getSource(REFERENCE_SOURCE);
      if (existing) {
        if (existing !== renderedReferenceSource || referenceKey !== renderedReferenceKey) existing.setData(referenceGeoJSON);
      } else map.addSource(REFERENCE_SOURCE, { type: 'geojson', data: referenceGeoJSON });
      renderedReferenceSource = map.getSource(REFERENCE_SOURCE); renderedReferenceKey = referenceKey;
      if (!map.getLayer(REFERENCE_LINE)) map.addLayer({ id: REFERENCE_LINE, type: 'line', source: REFERENCE_SOURCE,
        filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.65 } });
      if (!map.getLayer(REFERENCE_LAYER)) map.addLayer({ id: REFERENCE_LAYER, type: 'circle', source: REFERENCE_SOURCE,
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': '#f59e0b', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': 0.8 } });
      referenceErrorReported = false;
    } catch (error) {
      if (!referenceErrorReported) window.postMessage({ source: 'overlayable-bridge', type: 'reference-error', message: error.message }, location.origin);
      referenceErrorReported = true;
    }
  }

  // ---- 카메라 전송 ----
  function rectKey(rect) {
    return rect.left + ',' + rect.top + ',' + rect.width + ',' + rect.height;
  }

  function post() {
    if (!map) return;
    try {
      const c = map.getCenter();
      const rect = map.getContainer().getBoundingClientRect();
      // 지리적 중심의 컨테이너 내 px. rect 중앙 대신 project 를 쓰면 mapbox padding 까지 정확하다.
      let pt;
      try {
        pt = map.project(c);
      } catch (e) {
        pt = { x: rect.width / 2, y: rect.height / 2 };
      }
      window.postMessage(
        {
          source: 'overlayable-bridge',
          type: 'camera',
          lng: c.lng,
          lat: c.lat,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: typeof map.getPitch === 'function' ? map.getPitch() : 0,
          cx: rect.left + pt.x,
          cy: rect.top + pt.y,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        },
        location.origin
      );
      lastRectKey = rectKey(rect);
    } catch (e) {
      // 지도가 제거되는 중 등 — 다음 이벤트/폴링에서 회복
    }
  }

  // ---- 부착/해제 ----
  function attach(m, via) {
    map = m;
    stopPolling();
    console.info('[Overlayable] 지도 연동 성공 (경로: ' + via + ')');
    map.on('move', post); // 팬/줌/회전/피치 애니메이션(관성 포함) 동안 매 프레임 발화
    map.on('resize', post); // 에디터 분할선 드래그/창 크기 변경
    map.on('remove', onRemoved);
    map.on('style.load', renderReferences);
    map.on('idle', renderReferences);
    renderReferences();
    post();
    // 지도 resize 없이 일어나는 레이아웃 이동(상단 배너 삽입 등) 감지용 1초 감시.
    rectTimer = setInterval(() => {
      if (!map) return;
      try {
        const rect = map.getContainer().getBoundingClientRect();
        if (rectKey(rect) !== lastRectKey) post();
      } catch (e) {
        // 무시
      }
    }, 1000);
  }

  // 지도가 제거되면(SPA 리마운트 등) 정리하고 재탐색. 제거된 지도는 더 이상 이벤트를 내지 않으므로
  // 리스너 해제는 생략해도 무해하다.
  function onRemoved() {
    if (map?.off) map.off('style.load', renderReferences);
    if (map?.off) map.off('idle', renderReferences);
    map = null;
    editor = null;
    editorPersistence = null;
    editorData = null;
    editorDataSource = null;
    if (rectTimer) {
      clearInterval(rectTimer);
      rectTimer = null;
    }
    attempts = 0;
    startPolling(FAST_MS);
  }

  // ---- 폴링 ----
  function tick() {
    const found = discover();
    if (found) {
      attach(found.map, found.via);
      return;
    }
    attempts++;
    if (attempts === FAST_LIMIT) {
      console.warn(
        '[Overlayable] geojson.io 지도를 찾지 못했습니다 — 사진은 화면 고정으로 동작합니다. 계속 탐색합니다.'
      );
      startPolling(SLOW_MS);
    }
  }

  function startPolling(ms) {
    stopPolling();
    pollTimer = setInterval(tick, ms);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---- 콘텐츠 스크립트 핑 응답 ----
  // content.js 는 마운트 직후 ping 을 보낸다. 지도가 idle 이라 move 가 안 떠도
  // 즉시 카메라를 재전송해 연동시킨다(확장 리로드 후 재연결 포함).
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== 'overlayable-content') return;
    if (d.type === 'ping') { if (map) post(); refreshEditor(); return; }
    if (d.type === 'geojson-read') { refreshEditor(); postGeoJSON(d.requestId); return; }
    if (d.type === 'references-set') {
      referenceGeoJSON = d.geojson && Array.isArray(d.geojson.features) ? d.geojson : { type: 'FeatureCollection', features: [] };
      referenceKey = JSON.stringify(referenceGeoJSON);
      renderReferences(); return;
    }
    if (d.type === 'geojson-update' || d.type === 'geojson-insert') {
      updateFeatures(d.features, d.requestId, d.type === 'geojson-insert').catch((error) => window.postMessage({ source: 'overlayable-bridge',
        type: 'geojson-error', requestId: d.requestId, message: error.message }, location.origin));
      return;
    }
    if (d.type === 'geojson-replace') {
      replaceGeoJSON(d.geojson, d.requestId).catch((error) => window.postMessage({ source: 'overlayable-bridge',
        type: 'geojson-error', requestId: d.requestId, message: error.message }, location.origin));
      return;
    }
    if (d.type === 'geojson-patch-selected') {
      patchSelected(d.properties, d.requestId).catch((error) => window.postMessage({ source: 'overlayable-bridge',
        type: 'geojson-error', requestId: d.requestId, message: error.message }, location.origin));
    }
  });

  tick(); // 즉시 1회 시도
  if (!map) startPolling(FAST_MS);
  editorTimer = setInterval(refreshEditor, 1000);
})();
