// panel.js — 플로팅 컨트롤 패널 UI를 생성하고 이벤트를 바인딩한다.
// 패널은 항상 pointer-events:auto 이며, 컨트롤 조작 → handlers 콜백 → content.js 가 state 갱신.
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

  // handlers: { onUpload, onOpacity, onScale, onScaleStep, onRotation, onRotateStep, onReset, onRemove }
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

    // ---- 업로드 드롭존 ----
    const fileInput = el('input', {
      class: 'imgovl-file-input',
      type: 'file',
      accept: 'image/*',
    });
    const dropzone = el('div', { class: 'imgovl-dropzone' }, [
      el('span', { class: 'imgovl-dropzone-text', text: '이미지를 끌어다 놓거나 클릭해 선택' }),
      fileInput,
    ]);

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
      text: '제거',
    });
    resetBtn.addEventListener('click', () => handlers.onReset());
    removeBtn.addEventListener('click', () => handlers.onRemove());
    const actions = el('div', { class: 'imgovl-actions' }, [resetBtn, removeBtn]);

    // ---- 힌트 ----
    const hint = el('div', {
      class: 'imgovl-hint',
      text:
        'Ctrl 홀드 = 이미지 조작: 본체 드래그=이동, 꼭짓점·모서리=비율 유지 크기조절, 상단 핸들=회전(정밀), 휠=줌 / 놓으면 웹 조작',
    });

    // ---- 본문 ----
    const body = el('div', { class: 'imgovl-body' }, [
      dropzone,
      opacityRow,
      scaleRow,
      rotationRow,
      actions,
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

    // ---- 업로드 바인딩 ----
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) handlers.onUpload(file);
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
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) handlers.onUpload(file);
    });

    // ---- 상태 → 컨트롤 역동기화 ----
    function sync(state) {
      const opacityPct = Math.round(state.opacity * 100);
      opacity.slider.value = String(opacityPct);
      opacity.valueText.textContent = `${opacityPct}%`;

      const scalePct = Math.round(state.scale * 100);
      scale.slider.value = String(scalePct);
      scale.valueText.textContent = `${scalePct}%`;

      const rotDeg = T.round(state.rotation, 1);
      rotation.slider.value = String(rotDeg);
      rotation.valueText.textContent = `${rotDeg.toFixed(1)}°`;

      const isImageMode = state.mode === 'image';
      badge.textContent = isImageMode ? '이미지 모드' : '웹 모드';
      badge.classList.toggle('imgovl-badge-image', isImageMode);

      // 이미지가 없으면 변형/액션 컨트롤 비활성 표시.
      const hasImage = !!state.src;
      body.classList.toggle('imgovl-no-image', !hasImage);
    }

    return { panel, sync, setCollapsed };
  }

  NS.panel = { create };
})();
