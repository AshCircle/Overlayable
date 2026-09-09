const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('discovers separate persistence/data fibers and reads live selection and coordinates', () => {
  let listener;
  const messages = [];
  let data = { featureMap: new Map(), selection: { type: 'none' } };
  const atom = { read() {} };
  const store = { get: () => data };
  const persistence = { idMap: {}, useTransact: () => async () => {} };
  const fiber = { memoizedProps: { value: persistence }, child: {
    memoizedState: { memoizedState: [data, store, atom] }
  } };
  const host = { __reactFiber$test: fiber };
  const window = { postMessage: (m) => messages.push(m), addEventListener: (_, cb) => { listener = cb; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/bridge.js'), 'utf8'), {
    window, Map, Set, console: { info() {}, warn() {} },
    document: { querySelectorAll: () => [host] },
    location: { origin: 'https://geojson.io' }, setInterval() {}, clearInterval() {},
  });
  const read = () => {
    listener({ source: window, data: { source: 'overlayable-content', type: 'geojson-read', requestId: 'test' } });
    return messages.at(-1);
  };
  assert.equal(read().ready, true);
  const feature = { type: 'Feature', id: 'point', geometry: { type: 'Point', coordinates: [1, 2] } };
  data = { featureMap: new Map([['point', { feature }]]), selection: { type: 'single', id: 'point' } };
  assert.equal(read().selectedFeature, feature);
  data = { featureMap: new Map([['point', { feature: { ...feature, geometry: { type: 'Point', coordinates: [3, 4] } } }]]), selection: { type: 'none' } };
  assert.equal(read().selectedFeature, null);
  assert.deepEqual(read().geojson.features[0].geometry.coordinates, [3, 4]);
});
