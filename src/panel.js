// panel.js — 플로팅 컨트롤 패널 UI를 생성하고 이벤트를 바인딩한다.
// 패널은 항상 pointer-events:auto 이며, 컨트롤 조작 → handlers 콜백 → content.js 가 state 갱신.
// 다중 사진: 사진 목록(썸네일/선택/삭제)을 렌더하고, 슬라이더는 선택된 사진을 대상으로 동작한다.
// 역방향 동기화는 sync(state) 가 컨트롤의 .value 를 직접 설정(input 이벤트 미발생)해 루프를 막는다.
// 로드 순서: overlay.js 다음, content.js 이전.
(function () {
  'use strict';

  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const T = NS.transform;

  // 간단한 엘리먼트 생성 헬퍼.
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k in node) node[k] = v;
        else node.setAttribute(k, v);
      }
    }
    if (children) for (const c of children) node.appendChild(c);
    return node;
  }

  // handlers: { onUpload, onSelect, onDelete, onOpacity, onScale, onScaleStep,
  //             onRotation, onRotateStep, onReset, onRemove }
  function create(handlers) {
    let collapsed = false;

    // ---- 헤더: 제목 + 모드 배지 + 접기 버튼 ----
    const title = el('span', { class: 'imgovl-title', text: 'Overlayable' });
    const badge = el('span', { class: 'imgovl-badge', text: '웹 모드' });
    const collapseBtn = el('button', {
      class: 'imgovl-collapse-btn',
      type: 'button',
      title: '패널 접기/펼치기',
      text: '▾',
    });
    const header = el('div', { class: 'imgovl-header' }, [title, badge, collapseBtn]);

    // ---- HongGwart shared layer workspace ----
    const backendUrl = el('input', { class: 'imgovl-text', type: 'url', placeholder: 'http://localhost:8080' });
    const apiKey = el('input', { class: 'imgovl-text', type: 'password', placeholder: 'Admin API key' });
    const connectBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: '연결' });
    const layerSelect = el('select', { class: 'imgovl-text imgovl-layer-select' });
    layerSelect.appendChild(el('option', { value: '', text: '레이어 선택…' }));
    const newLayerBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: '새 레이어' });
    const copyLayerBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: '복사' });
    const renameLayerBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: '이름 변경' });
    const deleteLayerBtn = el('button', { class: 'imgovl-action-btn imgovl-danger', type: 'button', text: '삭제' });
    const geojsonExportBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: 'GeoJSON 내보내기' });
    const reloadLayerBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: '원격 다시 불러오기' });
    const verticalBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: '층 연결' });
    const syncStatus = el('div', { class: 'imgovl-sync-status', text: '백엔드 연결 필요' });
    const featureName = el('input', { class: 'imgovl-text', type: 'text', placeholder: '선택 Point 이름' });
    const featureType = el('select', { class: 'imgovl-text' });
    ['WAYPOINT','JUNCTION','ENTRANCE','VERTICAL_LINK','POI'].forEach((v) => featureType.appendChild(el('option',{value:v,text:v})));
    const featureSearchable = el('input', { type: 'checkbox' });
    const featureRoom = el('input', { class: 'imgovl-text', type: 'text', placeholder: '호실 번호' });
    const featureMeta = el('div', { class: 'imgovl-sync-status', text: 'Point를 선택하세요' });
    const featureSave = el('button', { class: 'imgovl-action-btn', type: 'button', text: '선택 Point 반영' });
    const workspace = el('section', { class: 'imgovl-workspace' }, [
      el('div', { class: 'imgovl-section-title', text: 'HongGwart 공유 레이어' }),
      backendUrl, apiKey, connectBtn, layerSelect,
      el('div', { class: 'imgovl-actions' }, [newLayerBtn, copyLayerBtn]),
      el('div', { class: 'imgovl-actions' }, [renameLayerBtn, deleteLayerBtn, verticalBtn]),
      el('div', { class: 'imgovl-actions' }, [geojsonExportBtn, reloadLayerBtn]),
      syncStatus,
      el('div', { class: 'imgovl-feature-editor' }, [
        el('div', { class: 'imgovl-section-title', text: '선택 Point' }), featureMeta, featureName, featureType,
        el('label', { class: 'imgovl-check-label' }, [featureSearchable, document.createTextNode(' 검색 가능')]),
        featureRoom, featureSave,
      ]),
    ]);

    connectBtn.addEventListener('click', () => handlers.onConnect(backendUrl.value, apiKey.value));
    layerSelect.addEventListener('change', () => { if (layerSelect.value) handlers.onLayerSelect(Number(layerSelect.value)); });
    function layerFields(prefix) {
      const name = prompt(`${prefix} 레이어 이름`); if (!name) return null;
      const buildingCode = prompt('건물 코드 (예: T, C)'); if (!buildingCode) return null;
      const buildingName = prompt('건물 이름 (예: T동)'); if (!buildingName) return null;
      const floor = prompt('층 코드 (예: 10, B1, L)'); if (!floor) return null;
      const floorOrder = Number(prompt('층 정렬 순서 (예: B1=-1, L=0, 10=10)', '0'));
      if (!Number.isInteger(floorOrder)) { alert('층 정렬 순서는 정수여야 합니다.'); return null; }
      return { name, buildingCode, buildingName, floor, floorOrder };
    }
    newLayerBtn.addEventListener('click', () => { const x=layerFields('새'); if(x) handlers.onLayerCreate(x); });
    copyLayerBtn.addEventListener('click', () => { const x=layerFields('복사할'); if(x) handlers.onLayerCopy(x); });
    renameLayerBtn.addEventListener('click', () => { const name=prompt('새 레이어 이름'); if(name) handlers.onLayerRename(name); });
    deleteLayerBtn.addEventListener('click', () => { const name=prompt('삭제할 레이어 이름을 정확히 입력하세요.'); if(name) handlers.onLayerDelete(name); });
    geojsonExportBtn.addEventListener('click', () => handlers.onGeoJSONExport());
    reloadLayerBtn.addEventListener('click', () => { if(confirm('저장되지 않은 로컬 GeoJSON 변경을 버리고 원격 데이터를 불러올까요?')) handlers.onLayerReload(); });
    verticalBtn.addEventListener('click', () => handlers.onVerticalConnect());
    featureSave.addEventListener('click', () => handlers.onFeatureSave({ name: featureName.value || null,
      nodeType: featureType.value, searchable: featureSearchable.checked, roomNumber: featureRoom.value || null }));

    // ---- 업로드 드롭존 ----
    const fileInput = el('input', {
      class: 'imgovl-file-input',
      type: 'file',
      accept: 'image/*',
      multiple: true,
    });
    const dropzone = el('div', { class: 'imgovl-dropzone' }, [
      el('span', { class: 'imgovl-dropzone-text', text: '이미지를 끌어다 놓거나 클릭해 선택' }),
      fileInput,
    ]);

    // ---- 사진 목록 ----
    const photoList = el('div', { class: 'imgovl-photo-list' });
    // 사진 id → { item, thumb }
    const photoItems = new Map();

    // ---- 슬라이더 행 헬퍼 ----
    function sliderRow(labelText, { min, max, step, value }) {
      const valueText = el('span', { class: 'imgovl-value' });
      const slider = el('input', {
        class: 'imgovl-slider',
        type: 'range',
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(value),
      });
      const label = el('label', { class: 'imgovl-label', text: labelText });
      const top = el('div', { class: 'imgovl-row-top' }, [label, valueText]);
      return { slider, valueText, top };
    }

    // 투명도
    const opacity = sliderRow('투명도', { min: 0, max: 100, step: 1, value: 100 });
    opacity.slider.addEventListener('input', () => handlers.onOpacity(Number(opacity.slider.value)));
    const opacityRow = el('div', { class: 'imgovl-control' }, [
      opacity.top,
      el('div', { class: 'imgovl-row-bottom' }, [opacity.slider]),
    ]);

    // 확대/축소 (− 슬라이더 +)
    const scale = sliderRow('확대/축소', {
      min: T.SCALE_MIN * 100,
      max: T.SCALE_MAX * 100,
      step: 1,
      value: 100,
    });
    scale.slider.addEventListener('input', () => handlers.onScale(Number(scale.slider.value)));
    const scaleMinus = el('button', { class: 'imgovl-step-btn', type: 'button', text: '−' });
    const scalePlus = el('button', { class: 'imgovl-step-btn', type: 'button', text: '+' });
    scaleMinus.addEventListener('click', () => handlers.onScaleStep(-0.1));
    scalePlus.addEventListener('click', () => handlers.onScaleStep(0.1));
    const scaleRow = el('div', { class: 'imgovl-control' }, [
      scale.top,
      el('div', { class: 'imgovl-row-bottom' }, [scaleMinus, scale.slider, scalePlus]),
    ]);

    // 회전 (−90 슬라이더 +90), 0.1° 단위로 정밀 조절
    const rotation = sliderRow('회전', {
      min: T.ROTATION_MIN,
      max: T.ROTATION_MAX,
      step: 0.1,
      value: 0,
    });
    rotation.slider.addEventListener('input', () => handlers.onRotation(Number(rotation.slider.value)));
    const rotMinus = el('button', { class: 'imgovl-step-btn', type: 'button', text: '−90°' });
    const rotPlus = el('button', { class: 'imgovl-step-btn', type: 'button', text: '+90°' });
    rotMinus.addEventListener('click', () => handlers.onRotateStep(-90));
    rotPlus.addEventListener('click', () => handlers.onRotateStep(90));
    const rotationRow = el('div', { class: 'imgovl-control' }, [
      rotation.top,
      el('div', { class: 'imgovl-row-bottom' }, [rotMinus, rotation.slider, rotPlus]),
    ]);

    // ---- 액션 버튼 ----
    const resetBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: '리셋' });
    const removeBtn = el('button', {
      class: 'imgovl-action-btn imgovl-danger',
      type: 'button',
      text: '선택 사진 제거',
    });
    resetBtn.addEventListener('click', () => handlers.onReset());
    removeBtn.addEventListener('click', () => handlers.onRemove());
    const actions = el('div', { class: 'imgovl-actions' }, [resetBtn, removeBtn]);

    // ---- 저장 관리: 내보내기 / 가져오기 ----
    // 내보내기: 현재 저장 상태를 JSON 파일로. 가져오기: 파일을 골라 기존 오버레이에 병합.
    const exportBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: '내보내기' });
    const importBtn = el('button', { class: 'imgovl-action-btn', type: 'button', text: '가져오기' });
    const importInput = el('input', {
      class: 'imgovl-file-input',
      type: 'file',
      accept: 'application/json,.json',
    });
    exportBtn.addEventListener('click', () => handlers.onExport());
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
      const file = importInput.files && importInput.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = () => handlers.onImport(String(reader.result || ''));
        reader.readAsText(file);
      }
      importInput.value = ''; // 같은 파일 재선택 허용
    });
    const storeActions = el('div', { class: 'imgovl-actions imgovl-store-actions' }, [
      exportBtn,
      importBtn,
      importInput,
    ]);

    // ---- 지도 연동 상태 ----
    // content.js 가 브리지 카메라를 수신하면 state.mapLinked 가 true 가 되어 sync 에서 갱신된다.
    const mapStatus = el('div', {
      class: 'imgovl-map-status',
      text: '지도 감지 대기 중 · 사진은 화면에 고정됩니다',
    });

    // ---- 힌트 ----
    // 조작 키 레이블: macOS 는 Command(⌘), 그 외는 Ctrl.
    const modeKeyLabel = /Mac|iPhone|iPad|iPod/.test(
      navigator.platform || navigator.userAgent || ''
    )
      ? '⌘'
      : 'Ctrl';
    const hint = el('div', {
      class: 'imgovl-hint',
      text: `지도를 움직이면 사진이 함께 이동/줌/회전. ${modeKeyLabel} 홀드 = 이미지 조작: 본체 드래그=이동(커서 아래 사진 선택), 꼭짓점·모서리=크기조절, 상단 핸들=회전, 휠=줌 — 조작한 사진은 새 위치에 다시 고정 / 놓으면 웹(지도) 조작`,
    });

    // ---- 본문 ----
    const body = el('div', { class: 'imgovl-body' }, [
      workspace,
      dropzone,
      photoList,
      opacityRow,
      scaleRow,
      rotationRow,
      actions,
      storeActions,
      mapStatus,
      hint,
    ]);

    const panel = el('div', { class: 'imgovl-panel' }, [header, body]);

    // ---- 접기/펼치기 ----
    function setCollapsed(next) {
      collapsed = next;
      panel.classList.toggle('imgovl-collapsed', collapsed);
      collapseBtn.textContent = collapsed ? '▸' : '▾';
    }
    collapseBtn.addEventListener('click', () => setCollapsed(!collapsed));

    // ---- 업로드 바인딩 (여러 장 지원) ----
    function uploadFiles(files) {
      for (const file of files) {
        if (file && file.type.startsWith('image/')) handlers.onUpload(file);
      }
    }
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length) uploadFiles(Array.from(fileInput.files));
      fileInput.value = ''; // 같은 파일 재선택 허용
    });
    dropzone.addEventListener('click', (e) => {
      if (e.target !== fileInput) fileInput.click();
    });
    ['dragenter', 'dragover'].forEach((type) =>
      dropzone.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('imgovl-dragover');
      })
    );
    ['dragleave', 'dragend'].forEach((type) =>
      dropzone.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('imgovl-dragover');
      })
    );
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('imgovl-dragover');
      if (e.dataTransfer && e.dataTransfer.files) uploadFiles(Array.from(e.dataTransfer.files));
    });

    // ---- 사진 목록 렌더 (id 기준 reconcile) ----
    function renderPhotoList(state) {
      const photos = state.photos || [];
      // 제거: 더 이상 없는 사진 항목.
      for (const [id, entry] of photoItems) {
        if (!photos.some((p) => p.id === id)) {
          entry.item.remove();
          photoItems.delete(id);
        }
      }
      // 생성 + 순서 정렬 + 선택 표시. 목록은 최신(위쪽 z-order)이 맨 위에 오도록 역순 표시.
      const ordered = photos.slice().reverse();
      ordered.forEach((p, idx) => {
        let entry = photoItems.get(p.id);
        if (!entry) {
          const thumb = el('img', { class: 'imgovl-thumb', alt: '', draggable: false });
          const label = el('span', { class: 'imgovl-photo-label' });
          const del = el('button', {
            class: 'imgovl-photo-del',
            type: 'button',
            title: '삭제',
            text: '×',
          });
          const item = el('div', { class: 'imgovl-photo-item' }, [thumb, label, del]);
          item.addEventListener('click', (e) => {
            if (e.target === del) return;
            handlers.onSelect(p.id);
          });
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            handlers.onDelete(p.id);
          });
          entry = { item, thumb, label };
          photoItems.set(p.id, entry);
        }
        if (entry.thumb.getAttribute('src') !== p.src) entry.thumb.src = p.src;
        const name = p.name || `사진 ${photos.length - idx}`;
        entry.label.textContent = name;
        entry.label.title = name;
        entry.item.classList.toggle('imgovl-selected', p.id === state.selectedId);
        photoList.appendChild(entry.item); // 순서 유지(역순)
      });

      photoList.classList.toggle('imgovl-empty', photos.length === 0);
    }

    // ---- 상태 → 컨트롤 역동기화 ----
    function sync(state) {
      renderPhotoList(state);

      const selected = state.selectedId != null
        ? (state.photos || []).find((p) => p.id === state.selectedId)
        : null;

      const opacityPct = Math.round((selected ? selected.opacity : 1) * 100);
      opacity.slider.value = String(opacityPct);
      opacity.valueText.textContent = `${opacityPct}%`;

      const scalePct = Math.round((selected ? selected.scale : 1) * 100);
      scale.slider.value = String(scalePct);
      scale.valueText.textContent = `${scalePct}%`;

      const rotDeg = T.round(selected ? selected.rotation : 0, 1);
      rotation.slider.value = String(rotDeg);
      rotation.valueText.textContent = `${rotDeg.toFixed(1)}°`;

      const isImageMode = state.mode === 'image';
      badge.textContent = isImageMode ? '이미지 모드' : '웹 모드';
      badge.classList.toggle('imgovl-badge-image', isImageMode);

      // 지도 연동 상태 표시.
      const linked = !!state.mapLinked;
      mapStatus.textContent = linked
        ? '지도 연동됨 · 사진이 지도에 고정됩니다'
        : '지도 감지 대기 중 · 사진은 화면에 고정됩니다';
      mapStatus.classList.toggle('imgovl-linked', linked);

      // 선택된 사진이 없으면 변형/액션 컨트롤 비활성 표시.
      body.classList.toggle('imgovl-no-selection', !selected);

      const ws = state.workspace || {};
      if (document.activeElement !== backendUrl) backendUrl.value = ws.baseUrl || 'http://localhost:8080';
      const existing = new Map(Array.from(layerSelect.options).map((o) => [o.value, o]));
      for (const layer of ws.layers || []) {
        const value=String(layer.id); let option=existing.get(value);
        if(!option){ option=el('option',{value}); layerSelect.appendChild(option); }
        option.textContent=`${layer.name} (${layer.buildingCode} ${layer.floor})`; existing.delete(value);
      }
      existing.delete(''); for(const option of existing.values()) option.remove();
      layerSelect.value = ws.layerId == null ? '' : String(ws.layerId);
      syncStatus.textContent = ws.status || '백엔드 연결 필요';
      syncStatus.className = 'imgovl-sync-status ' + (ws.error ? 'imgovl-sync-error' : '');
      const sf = ws.selectedFeature;
      const point = sf && sf.geometry && sf.geometry.type === 'Point';
      workspace.classList.toggle('imgovl-no-point', !point);
      if(point && document.activeElement !== featureName) {
        const p=sf.properties||{}; featureName.value=p.name||''; featureType.value=p.nodeType||'WAYPOINT';
        featureSearchable.checked=!!p.searchable; featureRoom.value=p.roomNumber||'';
        featureMeta.textContent = p.overlayable?.nodeId ? `Node #${p.overlayable.nodeId}` : '저장 후 Node ID가 부여됩니다';
      }
      verticalBtn.textContent = ws.connectionDraft ? '이 Point에 층 연결 완료' : '선택 Point에서 층 연결 시작';
    }

    return { panel, sync, setCollapsed };
  }

  NS.panel = { create };
})();
