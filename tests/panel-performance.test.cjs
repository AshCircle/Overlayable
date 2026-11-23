const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspace } = require('./helpers/workspace.cjs');

test('endpoint choices are reused until graph data or search changes', async () => {
  const h = await workspace();
  let nameReads = 0;
  const point = { type: 'Feature', id: 'saved-point', geometry: { type: 'Point', coordinates: [1, 1] },
    properties: { get name() { nameReads++; return 'Room 101'; }, overlayable: { nodeId: 101 },
      location: { buildingNodeId: 10, floor: '1', floorOrder: 1 } } };
  h.state.workspace.ownedPoints = [point];
  const endpoints = h.elements.find(el => el.getAttribute('aria-label') === '연결할 노드');
  for (let i = 0; i < 10; i++) h.panel.sync(h.state);
  assert.equal(nameReads, 1, 'status updates do not rebuild all endpoint labels');
  assert.ok(endpoints.options.some(option => option.textContent.includes('Room 101')));
  const search = h.elements.find(el => el.getAttribute('placeholder') === '현재·참조 노드 이름·건물·층·ID 검색');
  search.value = 'missing'; search.emit('input');
  assert.equal(endpoints.options.length, 1);
  search.value = 'room'; search.emit('input');
  assert.equal(endpoints.options.length, 2);
  assert.equal(nameReads, 1, 'search filters already prepared labels');
  h.state.workspace.ownedPoints = [];
  h.panel.sync(h.state);
  assert.equal(endpoints.options.length, 1, 'removed graph nodes cannot remain as candidates');
});

test('camera-only panel sync preserves workspace form drafts', async () => {
  const h = await workspace();
  const name = h.elements.find(el => el.getAttribute('placeholder') === '선택 Point 이름');
  const select = h.layerSelect;
  name.value = 'draft before focus moves';
  const options = select.options.slice();
  for (let i = 0; i < 10; i++) h.panel.syncCamera(h.state);
  assert.equal(name.value, 'draft before focus moves');
  assert.deepEqual(select.options, options);
});
