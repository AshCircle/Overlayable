const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const window = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/transform.js'), 'utf8'), { window });
const hash = (image) => JSON.stringify(window.__OVERLAYABLE__.transform.sharedImageTransform(image));

test('camera changes do not dirty anchored images, but image edits do', () => {
  const image = { id: 'photo', opacity: 1, x: 0, y: 0, scale: 1, rotation: 0,
    geo: { lat: 20, lng: 10, zoom: 5, scale: 1, rotation: 0 } };
  assert.equal(hash(image), hash({ ...image, x: 200, y: 1e-12, scale: 2, rotation: 90 }));
  assert.notEqual(hash(image), hash({ ...image, opacity: 0.5 }));
  assert.notEqual(hash(image), hash({ ...image, geo: { ...image.geo, lng: 11 } }));
  assert.notEqual(hash({ ...image, geo: {} }), hash({ ...image, geo: {}, x: 200 }));
});
