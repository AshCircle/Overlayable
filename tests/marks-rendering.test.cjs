const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspace } = require('./helpers/workspace.cjs');

function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test('overlay clips paths to map bounds and labels visible portions, even when both endpoints are off-screen', async () => {
  const h = await workspace(), marks = h.marksModule;
  const overlay = marks.createOverlay();
  const camera = { rect: { left: 100, top: 50, width: 300, height: 200 }, marks: [
    { code: 'C', type: 'LineString', points: [{ x: -100, y: 150 }, { x: 600, y: 150 }] },
    { code: 'F', type: 'Point', points: [{ x: 200, y: 100 }] },
    { code: 'A', type: 'Point', points: [{ x: 90, y: 100 }] },
    { code: 'G', type: 'LineString', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
  ] };
  overlay.sync({ active: true }, camera);
  const all = descendants(overlay.root);
  assert.equal(overlay.root.style.left, '100px');
  assert.equal(overlay.root.getAttribute('viewBox'), '0 0 300 200');
  assert.equal(all.filter(n => n.tagName === 'path').length, 3);
  assert.equal(all.find(n => n.tagName === 'path').getAttribute('d'), 'M0,100L300,100');
  const labels = all.filter(n => n.tagName === 'text');
  assert.deepEqual(labels.map(n => n.textContent), ['C', 'F']);
  assert.equal(labels[0].getAttribute('x'), '150');
  assert.equal(labels[1].getAttribute('x'), '100');
  const previous = overlay.root.firstChild;
  overlay.sync({ active: true }, camera);
  assert.equal(overlay.root.firstChild, previous, 'unchanged projections retain DOM');
  overlay.sync({ active: true }, { ...camera, marks: [] });
  assert.equal(descendants(overlay.root).filter(n => n.tagName === 'text').length, 0);
  overlay.sync({ active: false }, camera);
  assert.equal(overlay.root.style.display, 'none');
});

test('palette controls support mixed selections, keyboard labels, clear and disabled states', async () => {
  const h = await workspace();
  h.geojson.features = ['A', 'G'].map((code, i) => ({ type: 'Feature', id: `marked-${i}`,
    geometry: { type: i ? 'LineString' : 'Point', coordinates: i ? [[1, 1], [2, 2]] : [1, 1] },
    properties: { data: { overlayableMark: code } } }));
  h.selectFeatures(['marked-0', 'marked-1']); h.pollPanel();
  const chips = h.elements.filter(el => el.className.includes('imgovl-mark-chip'));
  assert.equal(chips.length, 7);
  assert.equal(chips[0].getAttribute('aria-label'), 'A 빨강 표시');
  assert.equal(chips[0].getAttribute('aria-pressed'), 'mixed');
  assert.equal(chips[6].getAttribute('aria-pressed'), 'mixed');
  assert.equal(chips[1].getAttribute('aria-pressed'), 'false');
  assert.ok(chips.every(chip => !chip.disabled));
  h.selectFeatures([]); h.pollPanel();
  assert.ok(chips.every(chip => chip.disabled));
  const clear = h.elements.find(el => el.textContent === '선택 표시 지우기');
  assert.equal(clear.disabled, true);
});

test('camera movement reuses annotation DOM and updates only its geometry', async () => {
  const h = await workspace(), overlay = h.marksModule.createOverlay();
  const rect = { left: 0, top: 0, width: 300, height: 200 };
  const marks = [
    { id: 'node', code: 'A', type: 'Point', points: [{ x: 40, y: 50 }] },
    { id: 'line', code: 'F', type: 'LineString', points: [{ x: 10, y: 80 }, { x: 200, y: 80 }] },
  ];
  overlay.sync({ active: true }, { rect, marks });
  const initial = descendants(overlay.root), created = h.elements.length;
  const label = initial.find(node => node.tagName === 'text' && node.textContent === 'A');
  const path = initial.find(node => node.tagName === 'path');
  for (let dx = 1; dx <= 20; dx++) overlay.sync({ active: true }, { rect,
    marks: marks.map(mark => ({ ...mark, points: mark.points.map(p => ({ x: p.x + dx, y: p.y })) })) });
  assert.equal(h.elements.length, created, 'panning must not allocate SVG nodes');
  assert.equal(descendants(overlay.root).find(node => node.tagName === 'path'), path);
  assert.equal(label.getAttribute('x'), '60');
  assert.equal(path.getAttribute('d'), 'M30,80L220,80');
  overlay.sync({ active: true }, { rect, marks: [marks[0]] });
  assert.equal(descendants(overlay.root).filter(node => node.tagName === 'path').length, 0);
  assert.equal(descendants(overlay.root).find(node => node.tagName === 'text'), label);
});
