// V2 editing controls. DOM-only UI; all network and graph mutations go through content.js.
(function () {
  'use strict';
  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const W = NS.workspace;
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) node.appendChild(child);
    return node;
  }
  const button = (text, fn) => { const node = el('button', { type: 'button', class: 'imgovl-action-btn', text }); node.addEventListener('click', fn); return node; };
  const input = (placeholder) => el('input', { class: 'imgovl-text', type: 'text', placeholder });
  const select = () => el('select', { class: 'imgovl-text' });
  const row = (...children) => el('div', { class: 'imgovl-actions' }, children);
  const label = (text, control) => el('label', { class: 'imgovl-field' }, [el('span', { text }), control]);
  const section = (title, children) => el('details', { class: 'imgovl-v2-section' }, [el('summary', { text: title }), ...children]);
  const clear = (node) => { while (node.firstChild) node.firstChild.remove(); };
  function options(node, values, desired) {
    const signature = JSON.stringify(values);
    if (node._options !== signature) {
      clear(node);
      values.forEach(([value, text]) => node.appendChild(el('option', { value: String(value), text })));
      node._options = signature;
    }
    if (desired != null && node.value !== String(desired)) node.value = String(desired);
  }

  function create(handlers) {
    let state, currentLayerId, locationDraft = [], locationSource = '', locationsDirty = false;
    let candidatesIdentity, selectedNodes = new Set(), selectedEdges = new Set();
    let renderedReferences = '', renderedPreview = '', renderedSelection = '';
    const root = el('div', { class: 'imgovl-workspace-v2' });
    const locationSummary = el('div', { class: 'imgovl-hint' });
    const defaultLocation = select(); defaultLocation.setAttribute('aria-label', '새 노드 기본 소속');
    defaultLocation.addEventListener('change', () => handlers.onDefaultLocation(defaultLocation.value));
    const classifyLocation = select(); classifyLocation.setAttribute('aria-label', '선택 노드 소속');
    const selectionCount = el('div', { class: 'imgovl-hint' });
    const classifyButton = button('선택 노드 소속 변경', () => handlers.onClassifySelected(classifyLocation.value));
    const locationList = el('div');
    const locationAdd = button('허용 소속 추가', () => {
      const buildingCode = prompt('건물 코드 (예: G, H)'); if (!buildingCode) return;
      const buildingName = prompt('건물 이름', `${buildingCode}동`); if (!buildingName) return;
      const floor = prompt('층 코드'); if (!floor) return;
      const floorOrder = Number(prompt('층 정렬 순서', /^-?\d+$/.test(floor) ? floor : '0'));
      if (!Number.isInteger(floorOrder)) { alert('층 정렬 순서는 정수여야 합니다.'); return; }
      if (locationDraft.some((x) => x.buildingCode === buildingCode && x.floor === floor)) { alert('이미 등록된 소속입니다.'); return; }
      locationDraft.push({ buildingCode, buildingName, floor, floorOrder }); locationsDirty = true; renderLocationDraft();
    });
    const locationSave = button('허용 소속 저장', async () => {
      await handlers.onLocationsSave(locationDraft.map(({ buildingCode, buildingName, floor, floorOrder }) => ({ buildingCode, buildingName, floor, floorOrder })));
      locationsDirty = false;
    });
    function renderLocationDraft() {
      clear(locationList);
      for (const [index, location] of locationDraft.entries()) locationList.appendChild(row(
        el('span', { class: 'imgovl-small', text: `${location.buildingName || location.buildingCode} ${location.floor}층` }),
        button('목록에서 제거', () => { locationDraft.splice(index, 1); locationsDirty = true; renderLocationDraft(); })));
    }
    const locationsPanel = section('소속 설정', [locationSummary, label('새 노드 기본 소속', defaultLocation),
      selectionCount, label('선택 노드 소속', classifyLocation), classifyButton,
      el('div', { class: 'imgovl-hint', text: '도면은 유지하고 각 노드의 실제 건물·층을 지정합니다. 기본 소속을 바꾸기 전에 기존 작업을 저장합니다.' }),
      locationList, row(locationAdd, locationSave)]);
    root.appendChild(locationsPanel);

    const referenceSelect = select(); referenceSelect.setAttribute('aria-label', '참조할 도면');
    const referenceAdd = button('참조 추가', () => { if (referenceSelect.value) handlers.onReferenceAdd(Number(referenceSelect.value)); });
    const referenceRefresh = button('참조 새로고침', () => handlers.onReferenceRefresh());
    const referenceList = el('div');
    const referencesPanel = section('참조 도면·노드 (읽기 전용)', [label('참조할 도면', referenceSelect), row(referenceAdd, referenceRefresh),
      el('div', { class: 'imgovl-hint', text: '여러 도면을 원래 위치로 표시합니다. 노란 점·점선은 참조 그래프이며 저장·이동·삭제 대상에 포함되지 않습니다.' }), referenceList]);
    root.appendChild(referencesPanel);

    const lineMeta = el('div', { class: 'imgovl-hint', text: 'LineString 하나를 선택하세요.' });
    const edgeType = select(); options(edgeType, ['CORRIDOR', 'OUTDOOR_PATH', 'STAIR', 'ELEVATOR', 'DOOR'].map((x) => [x, x]), 'CORRIDOR');
    const indoor = el('input', { type: 'checkbox' });
    const bidirectional = el('input', { type: 'checkbox' });
    const weightMode = select(); options(weightMode, [['AUTO', 'AUTO · 거리 자동 계산'], ['MANUAL', 'MANUAL · 구간별 가중치']], 'AUTO');
    const weights = input('예: 3, 5.5 (구간 순서대로)');
    weightMode.addEventListener('change', () => { weights.disabled = weightMode.value !== 'MANUAL'; });
    const lineSave = button('선 속성 반영', () => {
      const count = state?.workspace.selectedFeature?.geometry?.coordinates?.length - 1;
      let values = [];
      if (weightMode.value === 'MANUAL') {
        values = weights.value.split(',').map((value) => Number(value.trim()));
        if (values.length !== count || values.some((value) => !Number.isFinite(value) || value <= 0)) {
          alert(`${count}개 구간마다 양수 가중치를 쉼표로 구분해 입력하세요.`); return;
        }
      }
      handlers.onLineSave({ edgeType: edgeType.value, indoor: indoor.checked, bidirectional: bidirectional.checked,
        weightMode: weightMode.value, weights: values });
    });
    const endpointSearch = input('현재·참조 노드 이름·건물·층·ID 검색');
    const endpointSelect = select(); endpointSelect.setAttribute('aria-label', '연결할 노드');
    function renderEndpoints() {
      const query = endpointSearch.value.trim().toLowerCase();
      const local = (state?.workspace.ownedPoints || []).filter((feature) => feature.properties?.overlayable?.nodeId != null).map((feature) => ({ ...feature, properties: { ...feature.properties, overlayable: { ...feature.properties.overlayable, ownerLayerId: state.workspace.layerId } } }));
      const values = [...local, ...(state?.workspace.referenceFeatures || [])].filter((feature) => feature.geometry?.type === 'Point').map((feature) => {
        const props = feature.properties, meta = props.overlayable;
        const owner = state.workspace.layers.find((x) => x.id === meta.ownerLayerId);
        const actualLocation = W.locations(owner).find((value) => W.locationKey(value) === W.locationKey(props.location)) || props.location;
        const text = `${props.name || '이름 없음'} · ${W.locationLabel(actualLocation)} · ${owner?.name || `레이어 #${meta.ownerLayerId}`} · Node #${meta.nodeId}`;
        return [meta.nodeId, text];
      }).filter(([, text]) => text.toLowerCase().includes(query));
      const previous = endpointSelect.value;
      options(endpointSelect, [['', '연결할 노드 선택…'], ...values], values.some(([id]) => String(id) === previous) ? previous : '');
    }
    endpointSearch.addEventListener('input', renderEndpoints);
    const bindStart = button('시작점 연결', () => { if (endpointSelect.value) handlers.onEndpointBind('start', Number(endpointSelect.value)); });
    const bindEnd = button('끝점 연결', () => { if (endpointSelect.value) handlers.onEndpointBind('end', Number(endpointSelect.value)); });
    const unbindStart = button('시작점 연결 해제', () => handlers.onEndpointBind('start', null));
    const unbindEnd = button('끝점 연결 해제', () => handlers.onEndpointBind('end', null));
    const endpointStatus = el('div', { class: 'imgovl-hint' });
    const linePanel = section('선·외부 endpoint 편집', [lineMeta, label('이동 수단', edgeType),
      row(label('실내', indoor), label('양방향', bidirectional)), label('가중치 계산', weightMode), label('구간별 가중치 (m)', weights), lineSave,
      el('div', { class: 'imgovl-hint', text: '현재 도면 또는 참조 도면의 저장된 노드에 끝점을 연결합니다. 같은 도면의 다른 건물·층에도 명시적으로 연결할 수 있습니다. 연결 해제 시 새 로컬 노드가 됩니다.' }),
      endpointStatus, endpointSearch, endpointSelect, row(bindStart, bindEnd), row(unbindStart, unbindEnd)]);
    root.appendChild(linePanel);

    const transferSource = select(); transferSource.setAttribute('aria-label', '이전할 데이터 원본');
    const transferTarget = select(); transferTarget.setAttribute('aria-label', '이전할 공용 경로');
    const transferLoad = button('후보 불러오기', () => handlers.onTransferCandidates(transferSource.value ? Number(transferSource.value) : null));
    const candidateSearch = input('후보 이름·ID 검색');
    const candidateList = el('div', { class: 'imgovl-candidate-list' });
    const transferSelection = el('div', { class: 'imgovl-hint' });
    const previewText = el('pre', { class: 'imgovl-transfer-preview' });
    const transferPreview = button('이전 미리보기', () => {
      if (!transferTarget.value || (!selectedNodes.size && !selectedEdges.size)) { alert('공용 경로와 이전할 노드 또는 간선을 선택하세요.'); return; }
      handlers.onTransferPreview({ targetLayerId: Number(transferTarget.value), nodeIds: [...selectedNodes], edgeIds: [...selectedEdges] });
    });
    const transferExecute = button('미리보기대로 이전 실행', () => handlers.onTransferExecute());
    transferExecute.className += ' imgovl-danger';
    function selectionChanged() {
      transferSelection.textContent = `선택 노드 ${selectedNodes.size}개 · 간선 ${selectedEdges.size}개`;
      handlers.onTransferSelectionChange();
    }
    transferTarget.addEventListener('change', selectionChanged);
    function renderCandidates() {
      clear(candidateList);
      const data = state?.workspace.transferCandidates;
      if (!data) return;
      const query = candidateSearch.value.toLowerCase();
      const items = [
        ...(data.nodes || []).map((node) => ({ id: node.nodeId, selected: selectedNodes, text: `노드 #${node.nodeId} · ${node.name || node.nodeType || ''} · ${W.locationLabel(node.location)}` })),
        ...(data.edges || []).map((edge) => ({ id: edge.edgeId, selected: selectedEdges, text: `간선 #${edge.edgeId} · ${edge.fromNodeId} → ${edge.toNodeId} · ${edge.edgeType} · ${edge.indoor ? '실내' : '실외'}` })),
      ];
      for (const item of items.filter((x) => x.text.toLowerCase().includes(query))) {
        const checkbox = el('input', { type: 'checkbox', checked: item.selected.has(item.id) });
        checkbox.addEventListener('change', () => { if (state.workspace.operationBusy) { checkbox.checked = item.selected.has(item.id); return; } if (checkbox.checked) item.selected.add(item.id); else item.selected.delete(item.id); selectionChanged(); });
        candidateList.appendChild(label(item.text, checkbox));
      }
      transferSelection.textContent = `선택 노드 ${selectedNodes.size}개 · 간선 ${selectedEdges.size}개`;
    }
    candidateSearch.addEventListener('input', renderCandidates);
    const transferPanel = section('공용 경로로 이전', [
      el('div', { class: 'imgovl-hint', text: '원본 또는 미할당 데이터에서 옮길 항목을 직접 선택합니다. 선택한 노드의 연결 간선도 이전하며, 선택하지 않은 건물 endpoint는 원소속에 남습니다.' }),
      label('원본', transferSource), transferLoad, candidateSearch, candidateList, transferSelection,
      label('대상 공용 경로', transferTarget), transferPreview, previewText, transferExecute]);
    root.appendChild(transferPanel);

    const controls = [defaultLocation, classifyLocation, classifyButton, locationAdd, locationSave, referenceSelect, referenceAdd,
      referenceRefresh, edgeType, indoor, bidirectional, weightMode, weights, lineSave, endpointSearch, endpointSelect,
      bindStart, bindEnd, unbindStart, unbindEnd, transferSource, transferTarget, transferLoad, candidateSearch, transferPreview, transferExecute];
    function sync(next) {
      state = next;
      const ws = state.workspace || {};
      const layer = ws.layers.find((x) => x.id === ws.layerId);
      const shared = layer?.kind === 'SHARED_PATHS';
      const busy = ws.pendingLayerId != null || ws.operationBusy;
      for (const control of controls) control.disabled = busy || !layer;
      if (currentLayerId !== ws.layerId) { currentLayerId = ws.layerId; locationsDirty = false; locationSource = ''; }
      const available = W.locations(layer);
      const source = JSON.stringify(available);
      if (!locationsDirty && source !== locationSource) {
        locationSource = source; locationDraft = shared ? [] : available.map((x) => ({ ...x })); renderLocationDraft();
      }
      locationSummary.textContent = shared ? '공용 노드는 건물·층에 소속되지 않습니다.' : `허용 소속 ${available.length}개`;
      options(defaultLocation, available.map((x) => [W.locationKey(x), W.locationLabel(x)]), W.locationKey(ws.defaultLocation));
      options(classifyLocation, [['', '변경할 소속 선택…'], ...available.map((x) => [W.locationKey(x), W.locationLabel(x)])]);
      locationAdd.disabled = locationSave.disabled = busy || !layer || shared;
      defaultLocation.disabled = busy || !layer || shared;
      const points = (ws.selectedFeatures || []).filter((x) => x.geometry?.type === 'Point');
      const pointLocations = [...new Set(points.map((point) => W.locationKey(point.properties?.location)))];
      const pointSignature = JSON.stringify(points.map((point) => [point.id, point.properties?.location]));
      if (pointSignature !== renderedSelection) {
        renderedSelection = pointSignature;
        classifyLocation.value = pointLocations.length === 1 ? pointLocations[0] : '';
      }
      const locationNames = pointLocations.map((key) => available.find((value) => W.locationKey(value) === key))
        .map((value) => value ? W.locationLabel(value) : '저장 시 기본 소속 적용');
      selectionCount.textContent = `선택 Point ${points.length}개${locationNames.length ? ` · ${locationNames.join(', ')}` : ''}`;
      classifyButton.disabled = busy || !points.length;
      options(referenceSelect, [['', '도면 선택…'], ...ws.layers.filter((x) => x.id !== ws.layerId).map((x) => [x.id, x.name])]);
      referenceAdd.disabled = referenceRefresh.disabled = busy || !layer || ws.referenceLoading;
      const refsKey = JSON.stringify(ws.referenceSnapshots.map((x) => [x.layerId, x.revision]));
      if (refsKey !== renderedReferences) {
        renderedReferences = refsKey; clear(referenceList);
        for (const snapshot of ws.referenceSnapshots) {
          const ref = ws.layers.find((x) => x.id === snapshot.layerId);
          const opacity = el('input', { type: 'range', min: '0', max: '100', value: String(Math.round((ws.referencePhotos.find((photo) => photo.referenceLayerId === snapshot.layerId)?.opacity ?? .6) * 100)) });
          opacity.setAttribute('aria-label', `${ref?.name || snapshot.layerId} 참조 투명도`);
          opacity.addEventListener('input', () => handlers.onReferenceOpacity(snapshot.layerId, Number(opacity.value) / 100));
          referenceList.appendChild(el('div', { class: 'imgovl-reference-row' }, [el('span', { text: ref?.name || `레이어 #${snapshot.layerId}` }), opacity,
            button('참조 제거', () => handlers.onReferenceRemove(snapshot.layerId))]));
        }
      }
      const selected = ws.selectedFeatures || [];
      const line = selected.length === 1 && selected[0].geometry?.type === 'LineString' ? selected[0] : null;
      for (const control of [edgeType, indoor, bidirectional, weightMode, weights, lineSave]) control.disabled = busy || !line;
      lineMeta.textContent = line ? `${line.geometry.coordinates.length - 1}개 구간` : 'LineString 하나를 선택하세요.';
      if (line && ![edgeType, indoor, bidirectional, weightMode, weights].includes(document.activeElement)) {
        const p = line.properties || {};
        edgeType.value = p.edgeType || (shared ? 'OUTDOOR_PATH' : 'CORRIDOR');
        indoor.checked = p.indoor == null ? !shared : p.indoor; bidirectional.checked = p.bidirectional !== false;
        weightMode.value = p.weightMode || 'AUTO'; weights.value = (p.weights || []).join(', ');
      }
      weights.disabled = busy || !line || weightMode.value !== 'MANUAL';
      for (const control of [endpointSelect, endpointSearch, bindStart, bindEnd, unbindStart, unbindEnd]) control.disabled = busy || !line;
      const refs = line ? W.vertexRefs(line) : [];
      const endpointLabel = (ref) => {
        if (ref?.nodeId) return `레이어 #${ref.ownerLayerId} · Node #${ref.nodeId}`;
        const node = (ws.ownedPoints || []).find((point) => (point.properties?.overlayable?.editorId || point.id) === ref?.editorId);
        if (!node) return '새 로컬 노드';
        const actual = available.find((value) => W.locationKey(value) === W.locationKey(node.properties.location)) || node.properties.location;
        return `${node.properties.name || `Node #${node.properties.overlayable.nodeId}`} · ${W.locationLabel(actual)}`;
      };
      endpointStatus.textContent = line ? `시작: ${endpointLabel(refs[0])}\n끝: ${endpointLabel(refs.at(-1))}` : '';
      renderEndpoints();
      options(transferSource, [['', '미할당 데이터'], ...ws.layers.map((x) => [x.id, x.name])]);
      options(transferTarget, [['', '공용 경로 선택…'], ...ws.layers.filter((x) => x.kind === 'SHARED_PATHS').map((x) => [x.id, x.name])]);
      if (candidatesIdentity !== ws.transferCandidates) {
        candidatesIdentity = ws.transferCandidates; selectedNodes = new Set(); selectedEdges = new Set(); renderCandidates();
      }
      const preview = ws.transferPreview;
      const previewKey = JSON.stringify(preview);
      if (renderedPreview !== previewKey) {
        renderedPreview = previewKey;
        previewText.textContent = preview ? [
          `이전 노드 ${preview.nodeCount}개 · 간선 ${preview.edgeCount}개`,
          `노드: ${(preview.nodeIds || []).join(', ') || '없음'}`,
          `간선: ${(preview.edgeIds || []).join(', ') || '없음'}`,
          `원소속에 남는 endpoint: ${(preview.retainedNodeIds || []).join(', ') || '없음'}`,
          `영향 레이어: ${(preview.affectedLayerIds || []).join(', ')}`,
          ...(preview.locationsChanged || []).map((x) => `Node #${x.nodeId}: ${W.locationLabel(x.from)} → 공용 경로`),
          '노드 ID는 유지됩니다. 운영 데이터는 실행 버튼을 눌러야 변경됩니다.',
        ].join('\n') : '';
      }
      transferExecute.disabled = busy || !preview;
    }
    return { root, sync };
  }
  NS.workspacePanel = { create };
})();
