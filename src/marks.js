// A–G editing annotations. Only the small data key is persisted; artwork is a click-through overlay.
(function () {
  'use strict';
  const NS = (window.__OVERLAYABLE__ = window.__OVERLAYABLE__ || {});
  const palette = Object.freeze([
    { code: 'A', label: '빨강', color: '#ef4444', ink: '#111827' },
    { code: 'B', label: '주황', color: '#f97316', ink: '#111827' },
    { code: 'C', label: '노랑', color: '#facc15', ink: '#111827' },
    { code: 'D', label: '초록', color: '#22c55e', ink: '#111827' },
    { code: 'E', label: '파랑', color: '#2563eb', ink: '#ffffff' },
    { code: 'F', label: '남색', color: '#3730a3', ink: '#ffffff' },
    { code: 'G', label: '보라', color: '#9333ea', ink: '#ffffff' },
  ].map(Object.freeze));
  const byCode = new Map(palette.map((mark) => [mark.code, mark]));
  const isMarkable = (feature) => ['Point', 'LineString'].includes(feature?.geometry?.type)
    && !['node-reference', 'edge-reference'].includes(feature.properties?.overlayable?.kind);
  const getMark = (feature) => {
    const code = feature?.properties?.data?.overlayableMark;
    return byCode.has(code) ? code : null;
  };

  function withMark(feature, code) {
    if (!isMarkable(feature)) throw new Error('현재 레이어의 노드 또는 간선만 선택하세요.');
    if (code !== null && !byCode.has(code)) throw new Error('표시는 A–G 중에서 선택하세요.');
    const previous = feature.properties?.data;
    if (previous != null && (typeof previous !== 'object' || Array.isArray(previous))) {
      throw new Error('기존 data가 객체가 아닙니다. 데이터를 확인한 뒤 표시하세요.');
    }
    const data = { ...previous };
    if (code === null) delete data.overlayableMark;
    else data.overlayableMark = code;
    return { ...feature, properties: { ...feature.properties, data } };
  }

  function collection(geojson) {
    return { type: 'FeatureCollection', features: (geojson?.features || [])
      .filter((feature) => isMarkable(feature) && getMark(feature))
      .map((feature) => ({ type: 'Feature', id: feature.id,
        geometry: feature.geometry, properties: { overlayableMark: getMark(feature) } })) };
  }

  // Clip each screen segment to the map viewport so a partially visible line still gets a label.
  function clipSegment(a, b, width, height) {
    const dx = b.x - a.x, dy = b.y - a.y;
    let start = 0, end = 1;
    for (const [p, q] of [[-dx, a.x], [dx, width - a.x], [-dy, a.y], [dy, height - a.y]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const t = q / p;
      if (p < 0) start = Math.max(start, t); else end = Math.min(end, t);
      if (start > end) return null;
    }
    return [{ x: a.x + start * dx, y: a.y + start * dy }, { x: a.x + end * dx, y: a.y + end * dy }];
  }

  function createOverlay() {
    const svg = (tag, attrs = {}, text) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      if (text != null) node.textContent = text;
      return node;
    };
    const root = svg('svg', { class: 'imgovl-marks-overlay', 'aria-hidden': 'true' });
    const lines = svg('g'), labels = svg('g'), nodes = svg('g');
    root.appendChild(lines); root.appendChild(labels); root.appendChild(nodes);
    const entries = new Map();
    let renderedMarks = null, renderedRect = '';
    function badge(parent, mark, node) {
      const group = svg('g');
      group.appendChild(svg('title', {}, `${mark.code} · ${mark.label} ${node ? '노드' : '간선'}`));
      // Different silhouettes distinguish nodes (circle) from lines (rounded square).
      const shape = node ? 'circle' : 'rect';
      const position = node ? { r: 12 } : { width: 24, height: 24, rx: 5 };
      const shapes = [['#111827', 6], ['#ffffff', 3]].map(([stroke, width]) => {
        const element = svg(shape, { ...position, fill: mark.color, stroke, 'stroke-width': width });
        group.appendChild(element); return element;
      });
      const text = svg('text', { fill: mark.ink, 'text-anchor': 'middle', dy: '.35em' }, mark.code);
      text.style.setProperty('font', '800 15px/1 system-ui, sans-serif', 'important');
      text.style.setProperty('fill', mark.ink, 'important');
      group.appendChild(text);
      parent.appendChild(group);
      return { group, shapes, text, node };
    }
    function placeBadge(badge, p) {
      for (const shape of badge.shapes) {
        shape.setAttribute(badge.node ? 'cx' : 'x', String(badge.node ? p.x : p.x - 12));
        shape.setAttribute(badge.node ? 'cy' : 'y', String(badge.node ? p.y : p.y - 12));
      }
      badge.text.setAttribute('x', String(p.x)); badge.text.setAttribute('y', String(p.y));
    }
    function removeEntry(entry) {
      entry.badge.group.remove();
      for (const path of entry.paths) path.remove();
    }
    return { root, sync(state, camera) {
      const rect = camera?.rect;
      const visible = state.active && rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
        && rect.width > 0 && rect.height > 0;
      root.style.display = visible ? 'block' : 'none';
      if (!visible) return;
      Object.assign(root.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      root.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
      const marks = Array.isArray(camera.marks) ? camera.marks : [];
      const rectKey = `${rect.left},${rect.top},${rect.width},${rect.height}`;
      if (marks === renderedMarks && rectKey === renderedRect) return;
      renderedMarks = marks; renderedRect = rectKey;
      const seen = new Set();
      for (const [index, item] of marks.entries()) {
        const mark = byCode.get(item.code);
        if (!mark || !Array.isArray(item.points) || !item.points.length
          || item.points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
        const points = item.points.map((p) => ({ x: p.x - rect.left, y: p.y - rect.top }));
        let position, d = '';
        if (item.type === 'Point') {
          const p = points[0];
          if (p.x < 0 || p.x > rect.width || p.y < 0 || p.y > rect.height) continue;
          position = p;
        } else if (item.type === 'LineString' && points.length > 1) {
          const segments = points.slice(1).map((p, i) => clipSegment(points[i], p, rect.width, rect.height)).filter(Boolean);
          if (!segments.length) continue;
          d = segments.map(([a, b]) => `M${a.x},${a.y}L${b.x},${b.y}`).join(' ');
          const longest = segments.reduce((best, segment) => {
            const length = ([a, b]) => Math.hypot(b.x - a.x, b.y - a.y);
            return length(segment) > length(best) ? segment : best;
          });
          position = { x: (longest[0].x + longest[1].x) / 2, y: (longest[0].y + longest[1].y) / 2 };
        } else continue;
        let key = `${item.type}:${item.id ?? index}`;
        if (seen.has(key)) key += `:${index}`;
        seen.add(key);
        let entry = entries.get(key);
        if (entry && entry.code !== mark.code) { removeEntry(entry); entries.delete(key); entry = null; }
        if (!entry) {
          const isNode = item.type === 'Point';
          const paths = isNode ? [] : [['#111827', 12], ['#ffffff', 9], [mark.color, 5]].map(([stroke, width]) => {
            const path = svg('path', { fill: 'none', stroke, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
            lines.appendChild(path); return path;
          });
          entry = { code: mark.code, paths, badge: badge(isNode ? nodes : labels, mark, isNode), d: null };
          entries.set(key, entry);
        }
        if (entry.d !== d) { for (const path of entry.paths) path.setAttribute('d', d); entry.d = d; }
        placeBadge(entry.badge, position);
      }
      for (const [key, entry] of entries) if (!seen.has(key)) { removeEntry(entry); entries.delete(key); }
    } };
  }

  NS.marks = { palette, getMark, isMarkable, withMark, collection, clipSegment, createOverlay };
})();
