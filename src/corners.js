// Floor-plan reference points are metadata, never editable graph features.
(function () {
  'use strict';
  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const empty = () => ({ imageId: null, points: [null, null], dirty: false, picking: null, saving: false });
  function point(longitude, latitude) {
    if (longitude === '' || latitude === '') throw new Error('경도와 위도를 모두 입력하세요.');
    const value = { longitude: Number(longitude), latitude: Number(latitude) };
    if (!Number.isFinite(value.longitude) || !Number.isFinite(value.latitude)
      || Math.abs(value.longitude) > 180 || Math.abs(value.latitude) > 90) {
      throw new Error('경도는 -180~180, 위도는 -90~90 사이의 숫자여야 합니다.');
    }
    return value;
  }
  function validate(draft) {
    if (!draft.imageId) throw new Error('서버에 저장된 평면도 사진을 선택하세요.');
    if (draft.points.length !== 2 || draft.points.some((p) => !p)) throw new Error('기준점 1과 2를 모두 지정한 뒤 저장하거나 층을 전환하세요.');
    const points = draft.points.map((p) => point(p.longitude, p.latitude));
    if (points[0].longitude === points[1].longitude && points[0].latitude === points[1].latitude) {
      throw new Error('기준점 1과 2는 서로 다른 위치여야 합니다.');
    }
    return points;
  }
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = el('button', text, 'imgovl-action-btn'); node.type = 'button';
    node.addEventListener('click', action); return node;
  };
  function createPanel(handlers) {
    let state;
    const root = el('details', null, 'imgovl-v2-section imgovl-corners-panel');
    root.appendChild(el('summary', '평면도 기준점 1·2'));
    root.appendChild(el('div', 'C동·A동·L/J 합본별로 같은 물리적 꼭짓점과 1·2 순서를 사용하세요. 사진 배치를 마친 후 두 점을 지정하세요. 사진을 이동·확대·회전하면 다시 지정해야 합니다.', 'imgovl-hint'));
    const imageName = el('div', null, 'imgovl-hint'); root.appendChild(imageName);
    const useImage = button('선택한 사진의 기준점 지정', () => handlers.onCornerImage()); root.appendChild(useImage);
    const rows = [0, 1].map((index) => {
      const row = el('div', null, 'imgovl-corner-row');
      row.appendChild(el('strong', `기준점 ${index + 1}`));
      const longitude = el('input', null, 'imgovl-text'); longitude.type = 'number'; longitude.step = 'any'; longitude.placeholder = '경도';
      const latitude = el('input', null, 'imgovl-text'); latitude.type = 'number'; latitude.step = 'any'; latitude.placeholder = '위도';
      longitude.setAttribute('aria-label', `기준점 ${index + 1} 경도`); latitude.setAttribute('aria-label', `기준점 ${index + 1} 위도`);
      // Write each keystroke into the draft, including incomplete values, so sync cannot erase typing.
      const change = () => handlers.onCornerCoordinate(index, longitude.value, latitude.value);
      longitude.addEventListener('input', change); latitude.addEventListener('input', change);
      const pick = button(`지도에서 ${index + 1} 찍기`, () => handlers.onCornerPick(index));
      row.appendChild(longitude); row.appendChild(latitude); row.appendChild(pick); root.appendChild(row);
      return { longitude, latitude, pick };
    });
    const status = el('div', null, 'imgovl-hint'); status.setAttribute('role', 'status'); root.appendChild(status);
    const actions = el('div', null, 'imgovl-actions');
    const save = button('기준점 저장', () => handlers.onCornerSave());
    const cancel = button('찍기 취소 (Esc)', () => handlers.onCornerCancel());
    const discard = button('기준점 편집 취소', () => handlers.onCornerDiscard());
    actions.appendChild(save); actions.appendChild(cancel); root.appendChild(actions); root.appendChild(discard);
    return { root, sync(next) {
      state = next;
      const ws = state.workspace, draft = ws.corners || empty();
      const layer = ws.layers.find((item) => item.id === ws.layerId);
      const enabled = layer?.kind === 'FLOOR_PLAN';
      const busy = ws.pendingLayerId != null || ws.operationBusy || draft.saving;
      const selected = state.photos.find((p) => p.id === state.selectedId);
      const photo = state.photos.find((p) => p.remoteId === draft.imageId);
      imageName.textContent = !enabled ? '도면 레이어를 선택하세요. 공용 경로는 기준점을 지원하지 않습니다.'
        : photo ? `기준점 사진: ${photo.name}` : '사진 목록에서 서버 평면도를 선택한 뒤 기준점 지정을 시작하세요.';
      useImage.disabled = busy || !enabled || !selected?.remoteId || selected.readonly;
      for (const [index, row] of rows.entries()) {
        row.longitude.disabled = row.latitude.disabled = busy || !enabled || !photo;
        row.pick.disabled = busy || !enabled || !photo || !state.mapLinked || ws.cornerPitch !== 0;
        row.pick.textContent = draft.picking === index ? `${index + 1} 찍는 중…` : `지도에서 ${index + 1} 찍기`;
        for (const key of ['longitude', 'latitude']) {
          const value = draft.points[index]?.[key] ?? '';
          if (document.activeElement !== row[key] && row[key].value !== String(value)) row[key].value = String(value);
        }
      }
      save.disabled = busy || !enabled || !draft.dirty;
      cancel.disabled = draft.picking == null;
      discard.disabled = busy || !draft.dirty;
      status.textContent = draft.saving ? '기준점 저장 중…' : draft.picking != null
        ? `지도에서 기준점 ${draft.picking + 1}을 클릭하세요. Esc로 취소합니다.`
        : draft.error || (enabled && state.mapLinked && ws.cornerPitch !== 0 ? '기울임(pitch)을 0으로 되돌려야 지도에서 찍을 수 있습니다.'
          : draft.dirty ? '미저장 기준점 · 두 점을 지정하면 자동 저장됩니다.' : draft.imageId ? '저장된 기준점' : '기준점 미등록');
    } };
  }
  function createOverlay(onPick) {
    const root = el('div', null, 'imgovl-corners-overlay');
    const picker = el('div', null, 'imgovl-corner-picker'); root.appendChild(picker);
    picker.setAttribute('aria-label', '평면도 기준점 지도 클릭 영역');
    // A separate hit target prevents Draw Point/LineString from receiving a calibration click.
    for (const eventName of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
      picker.addEventListener(eventName, (event) => { event.preventDefault(); event.stopPropagation(); });
    }
    picker.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); onPick(event.clientX, event.clientY); });
    const markers = [1, 2].map((number) => {
      const marker = el('div', String(number), `imgovl-corner-marker imgovl-corner-${number}`);
      marker.setAttribute('aria-label', `평면도 기준점 ${number}`); root.appendChild(marker); return marker;
    });
    return { root, sync(state, camera) {
      const draft = state.workspace.corners || empty(), rect = camera?.rect;
      const visible = state.active && camera && camera.pitch === 0;
      picker.style.display = visible && rect && draft.picking != null ? 'block' : 'none';
      if (rect) Object.assign(picker.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      markers.forEach((marker, index) => {
        let p;
        try { const value = draft.points[index]; p = value && point(value.longitude, value.latitude); } catch (_) { /* incomplete input */ }
        const screen = visible && p ? NS.geo.project({ lng: p.longitude, lat: p.latitude }, camera) : null;
        const inside = screen && rect && screen.x >= rect.left && screen.x <= rect.left + rect.width && screen.y >= rect.top && screen.y <= rect.top + rect.height;
        marker.style.display = inside ? 'grid' : 'none';
        if (inside) { marker.style.left = `${screen.x}px`; marker.style.top = `${screen.y}px`; }
      });
    } };
  }
  NS.corners = { empty, point, validate, createPanel, createOverlay };
})();
