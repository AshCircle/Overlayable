const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {};
    this.checked = false; this.disabled = false; this.style = { setProperty() {} }; this.value = ''; this.className = ''; this.textContent = '';
    const classes = new Set();
    this.classList = { add: x => classes.add(x), remove: x => classes.delete(x),
      toggle: (x, on) => on ? classes.add(x) : classes.delete(x) };
  }
  get options() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    child.remove();
    const index = before == null ? this.children.length : this.children.indexOf(before);
    this.children.splice(index, 0, child); child.parentElement = this; return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, event = {}) { for (const fn of this.listeners[name] || []) fn({ target: this, ...event }); }
}

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function collection(id) {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', id: `point-${id}`,
    geometry: { type: 'Point', coordinates: [id, id] }, properties: { name: `floor-${id}` } }] };
}
function snapshot(id) {
  return { layerId: id, revision: 1, protocolVersion: 2, geojson: collection(id), images: [{ id: `image-${id}`,
    contentHash: `hash-${id}`, contentUrl: `/images/${id}`, contentType: 'image/png', name: `floor-${id}.png`,
    x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.6, naturalWidth: 640, naturalHeight: 480, geo: {} }] };
}

async function workspace() {
  const h = { requests: [], replacements: [], elements: [], snapshots: new Map([1, 2, 3].map(id => [id, snapshot(id)])),
    confirmations: [], geojson: { type: 'FeatureCollection', features: [] }, requestHook: null };
  const listeners = new Map(), timers = new Map(), intervals = new Map();
  let timerId = 0;
  const document = { documentElement: new Element(), body: new Element(), activeElement: null,
    createElement(tag) { const el = new Element(tag); h.elements.push(el); return el; },
    createTextNode(text) { const el = new Element('#text'); el.textContent = text; return el; }, addEventListener() {} };
  const window = { innerWidth: 1000, innerHeight: 800,
    addEventListener(name, fn) { (listeners.get(name) || listeners.set(name, []).get(name)).push(fn); },
    postMessage(message) {
      if (!message.requestId) return;
      queueMicrotask(() => {
        if (message.type === 'geojson-insert') h.geojson.features.push(...structuredClone(message.features));
        if (message.type === 'geojson-update') {
          const replacements = new Map(message.features.map(f => [f.id, f]));
          h.geojson.features = h.geojson.features.map(f => structuredClone(replacements.get(f.id) || f));
        }
        if (message.type === 'geojson-patch-selected') {
          const ids = new Set(h.selectedIds || []);
          h.geojson.features = h.geojson.features.map(f => ids.has(f.id) ? { ...f, properties: { ...f.properties, ...message.properties } } : f);
        }
        if (message.type === 'geojson-replace') {
          h.geojson = structuredClone(message.geojson); h.replacements.push(structuredClone(h.geojson));
        }
        h.emitGeoJSON(message.requestId);
      });
    } };
  h.emitGeoJSON = requestId => {
    for (const fn of listeners.get('message') || []) fn({ source: window, origin: 'https://geojson.io', data: {
      source: 'overlayable-bridge', type: 'geojson-state', requestId, ready: true, geojson: structuredClone(h.geojson),
      selectedFeatures: h.geojson.features.filter(f => (h.selectedIds || []).includes(f.id)),
      selectedFeature: h.geojson.features.find(f => (h.selectedIds || []).includes(f.id)) || null } });
  };
  h.defaultRequest = async (url, options = {}) => {
    if (url === '/api/admin/layers?protocolVersion=2') return { data: [1, 2, 3].map(id => ({ id, name: `${id}층`, buildingCode: 'C', buildingNodeId: 10, floor: String(id), floorOrder: id, revision: h.snapshots.get(id).revision, kind: 'FLOOR_PLAN', locations: [{ buildingNodeId: 10, buildingCode: 'C', buildingName: 'C동', floor: String(id), floorOrder: id }] })) };
    const match = url.match(/^\/api\/admin\/layers\/(\d+)\/snapshot\?protocolVersion=2$/);
    if (match) {
      const id = Number(match[1]);
      const saved = h.snapshots.get(id);
      if (options.method === 'PUT') {
        if (options.body.expectedRevision !== saved.revision) throw Object.assign(new Error('conflict'), { status: 409 });
        saved.revision++;
        saved.geojson = structuredClone(options.body.geojson);
        saved.defaultLocation = structuredClone(options.body.defaultLocation);
      }
      return { data: structuredClone(saved) };
    }
    if (url.startsWith('/images/')) return { data: `base64-${url}` };
    throw Error(`Unexpected request: ${url}`);
  };
  const NS = window.__OVERLAYABLE__ = {
    overlay: { createContainer: () => new Element(), HANDLE_DEFS: [], applyFrame() {},
      createFrame: () => ({ frame: new Element(), img: new Element('img'), handles: {}, rotHandle: new Element() }) },
    storage: { load: async () => null, save() {} },
    api: { settings: async () => ({ baseUrl: 'https://test.invalid', hasApiKey: false }),
      configure: async () => {}, setLastLayer: async () => {},
      request: async (url, options = {}) => {
        h.requests.push({ url, ...structuredClone(options) });
        return h.requestHook ? h.requestHook(url, options) : h.defaultRequest(url, options);
      } },
  };
  const context = vm.createContext({ window, document, navigator: { platform: 'MacIntel' }, crypto: webcrypto,
    location: { origin: 'https://geojson.io' }, console, URL, Blob,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    MutationObserver: class { observe() {} }, confirm: (message) => { h.confirmations.push(message); return true; },
    prompt: () => (h.promptAnswers || []).shift() ?? null,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval(fn, ms) { intervals.set(ms, fn); },
    requestAnimationFrame() {} });
  function load(file) { vm.runInContext(fs.readFileSync(path.join(__dirname, '../../', file), 'utf8'), context, { filename: file }); }
  load('src/transform.js'); load('src/workspace.js'); load('src/workspace-panel.js'); load('src/panel.js');
  const createPanel = NS.panel.create;
  NS.panel.create = handlers => {
    h.handlers = handlers;
    const panel = createPanel(handlers);
    h.panel = panel;
    const sync = panel.sync;
    panel.sync = state => { h.state = state; sync(state); };
    return panel;
  };
  load('src/content.js');
  await turn();
  await h.handlers.onConnect('https://test.invalid', '');
  h.selectFeatures = ids => { h.selectedIds = ids; h.emitGeoJSON(); };
  h.select = id => h.handlers.onLayerSelect(id);
  h.autosync = () => intervals.get(10000)();
  h.pollPanel = () => { h.emitGeoJSON(); for (const [id, timer] of timers) if (timer.ms === 100) { timers.delete(id); timer.fn(); } };
  h.layerSelect = h.elements.find(el => el.className.includes('imgovl-layer-select'));
  h.status = h.elements.find(el => el.getAttribute('role') === 'status');
  await h.select(1);
  h.requests.length = 0; h.replacements.length = 0;
  return h;
}
module.exports = { workspace, turn, deferred, collection };
