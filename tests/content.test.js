import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const passage = id => `Passage ${id}: The library opens at nine on weekdays, and books can be renewed at the front desk using a library card.`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

// A small DOM/runtime fixture exercises the actual content script in Node.
// Geometry and mutations are explicit; no browser or paid API is involved.
class Element {
  constructor(tag = 'p', text = '', attrs = {}) {
    this.tag = tag; this.text = text; this.attrs = attrs; this.children = [];
    this.parentElement = null; this.nodeType = 1; this.dataset = {}; this.events = {};
    this.rect = {width: 400, height: 60, top: 0, bottom: 60, left: 0, right: 400};
    this.display = 'block'; this.visibility = 'visible';
    const properties = new Map();
    this.style = {
      get position() { return properties.get('position')?.value || ''; },
      getPropertyValue: key => properties.get(key)?.value || '',
      getPropertyPriority: key => properties.get(key)?.priority || '',
      setProperty: (key, value, priority) => properties.set(key, {value, priority}),
      removeProperty: key => properties.delete(key)
    };
  }
  get isConnected() { return this.root || !!this.parentElement?.isConnected; }
  get innerText() { return [this.text, ...this.children.map(node => node.innerText)].filter(Boolean).join(' '); }
  matches(selector) {
    return selector.split(',').some(part => {
      const s = part.trim();
      if (s === '[contenteditable]:not([contenteditable="false"])') return this.attrs.contenteditable !== undefined && this.attrs.contenteditable !== 'false';
      const compound = s.match(/^([a-z]+)(\[.*\])$/);
      if (compound) return this.tag === compound[1] && this.matches(compound[2]);
      const attr = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attr) return this.hasAttribute(attr[1]) && (attr[2] === undefined || this.attrs[attr[1]] === attr[2]);
      return this.tag === s;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  hasAttribute(key) { return key === 'data-slop-shield' ? !!this.dataset.slopShield : key in this.attrs; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getBoundingClientRect() { return this.rect; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
  attachShadow() { this.shadow = new Element('shadow'); return this.shadow; }
  addEventListener(type, callback) { this.events[type] = callback; }
}

async function fixture({nodes = [], cached = new Map(), limit = 120, classify, lookup} = {}) {
  const body = new Element('body'); body.root = true; body.append(...nodes);
  const config = {enabled: true, configured: true, threshold: .85, limit, filterId: 'rule-one'};
  const timers = new Map(), events = {}, detects = [], lookups = [], requests = [];
  let timerId = 0, listener, observer;
  const document = {
    body, hidden: false, querySelectorAll: selector => body.querySelectorAll(selector),
    createElement: tag => new Element(tag), addEventListener: (type, callback) => { events[type] = callback; }
  };
  vm.runInNewContext(source, {
    document, innerHeight: 800, innerWidth: 1200,
    getComputedStyle: node => ({display: node.display, visibility: node.visibility, position: node.style.position || 'static'}),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    addEventListener: (type, callback) => { events[type] = callback; },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    },
    chrome: {runtime: {
      onMessage: {addListener: fn => { listener = fn; }},
      sendMessage: async message => {
        requests.push(message);
        if (message.type === 'CONFIG') return {...config};
        if (message.type === 'CACHE_LOOKUP') {
          lookups.push([...message.texts]);
          return lookup ? lookup(message.texts) : {scores: message.texts.map(text => cached.get(text) ?? null)};
        }
        if (message.type === 'DETECT') {
          detects.push(message.text);
          return classify ? classify(message.text) : {score: .95, source: 'api'};
        }
        throw new Error('Unexpected message');
      }
    }}
  });
  const flush = async () => {
    // setImmediate drains Promise callbacks created by the isolated VM as well.
    for (let i = 0; i < 500; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (!timers.size) return;
      const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn());
    }
    throw new Error('Scan did not settle (possible scheduling loop)');
  };
  const mutate = () => { if (observer?.connected) observer.callback([{type: 'childList', target: body, addedNodes: [body], removedNodes: []}]); };
  const message = type => new Promise(resolve => listener({type}, {}, resolve));
  await flush();
  return {body, config, detects, lookups, requests, flush, mutate, message, events, timers, document};
}
const covered = node => node.children.some(child => child.dataset.slopShield === 'cover');

test('discovers offscreen passages, prioritizes visible text, and keeps nested tweet text whole', async () => {
  const distant = new Element('p', passage('distant')); distant.rect.top = 8000; distant.rect.bottom = 8060;
  const above = new Element('p', passage('above')); above.rect.top = -1000; above.rect.bottom = -940;
  const visible = new Element('p', passage('visible'));
  const tweet = new Element('div', '', {'data-testid': 'tweetText'});
  tweet.append(new Element('div', passage('tweet part one'), {dir: 'auto'}), new Element('div', passage('tweet part two'), {dir: 'auto'}));
  const hidden = new Element('div'); hidden.display = 'none'; hidden.append(new Element('p', passage('hidden')));
  const nav = new Element('nav'); nav.append(new Element('p', passage('navigation')));
  const h = await fixture({nodes: [distant, above, visible, tweet, hidden, nav]});
  assert.equal(h.detects.length, 4);
  assert.equal(h.detects[0], visible.text);
  assert.equal(h.detects[1], tweet.innerText);
  assert.equal(h.detects[2], above.text);
  assert.equal(h.detects[3], distant.text);
  assert.ok([distant, above, visible, tweet].every(covered));
  assert.equal((await h.message('STATUS')).checked, 4);
});

test('bulk cache hits beyond the API limit still cover and zero scores remain visible', async () => {
  const nodes = Array.from({length: 130}, (_, i) => new Element('p', passage(i)));
  const cached = new Map(nodes.map(node => [node.text, .95])); cached.set(nodes[0].text, 0);
  const fresh = new Element('p', passage('fresh'));
  const h = await fixture({nodes: [...nodes, fresh], cached, limit: 1});
  assert.equal(h.detects.length, 1);
  assert.ok(h.lookups.every(batch => batch.length <= 64));
  assert.equal(h.lookups.flat().length, 131);
  assert.equal(covered(nodes[0]), false);
  assert.ok(nodes.slice(1).every(covered));
  assert.ok(covered(fresh));
  assert.equal((await h.message('STATUS')).evaluated, 1);
  const later = new Element('p', passage('later cached')); cached.set(later.text, .98);
  h.body.append(later); h.mutate(); await h.flush();
  assert.ok(covered(later));
  assert.equal(h.detects.length, 1);
});

test('recreated content is covered from memory while another evaluation is pending', async () => {
  const original = new Element('p', passage('cached'));
  const slow = new Element('p', passage('slow'));
  const wait = deferred();
  const h = await fixture({nodes: [original, slow], cached: new Map([[original.text, .95]]), classify: () => wait.promise});
  assert.ok(covered(original));
  assert.equal(h.detects.length, 1);
  original.remove(); h.mutate(); await h.flush();
  const replacement = new Element('p', original.text);
  const lookupCount = h.lookups.length;
  h.body.append(replacement); h.mutate();
  for (let i = 0; i < 100; i++) h.events.scroll();
  assert.equal(h.timers.size, 1, 'scroll events must coalesce without postponing the scan');
  await h.flush();
  assert.ok(covered(replacement));
  assert.equal(h.lookups.length, lookupCount);
  assert.equal((await h.message('STATUS')).busy, true);
  wait.resolve({score: .9, source: 'api'}); await h.flush();
});

test('results survive node removal and never cover a recycled node with the old score', async () => {
  const node = new Element('p', passage('original'));
  const oldText = node.text, wait = deferred();
  const h = await fixture({nodes: [node], classify: text => text === oldText ? wait.promise : {score: 0, source: 'api'}});
  node.text = passage('replacement'); h.mutate(); await h.flush();
  wait.resolve({score: .99, source: 'api'}); await h.flush();
  assert.equal(covered(node), false);
  const returned = new Element('p', oldText); h.body.append(returned); h.mutate(); await h.flush();
  assert.ok(covered(returned));
  assert.equal(h.detects.length, 2);
  returned.remove(); h.mutate(); await h.flush();
  assert.equal((await h.message('STATUS')).covered, 0);
});

test('API errors stop new evaluations but do not stop cached covers', async () => {
  const cached = new Map();
  const h = await fixture({nodes: [new Element('p', passage('error'))], cached, classify: () => ({error: 'Offline'})});
  assert.equal((await h.message('STATUS')).error, 'Offline');
  const node = new Element('p', passage('cached after error')); cached.set(node.text, .95);
  h.body.append(node); h.mutate(); await h.flush();
  assert.ok(covered(node));
  assert.equal(h.detects.length, 1);
});

test('rescan during an outstanding evaluation resumes without parallel DETECT requests', async () => {
  const wait = deferred(), node = new Element('p', passage('rescan'));
  let calls = 0;
  const h = await fixture({nodes: [node], classify: () => ++calls === 1 ? wait.promise : {score: .95, source: 'cache'}});
  await h.message('RESCAN'); await h.flush();
  assert.equal(calls, 1);
  wait.resolve({score: .95, source: 'api'}); await h.flush();
  assert.equal(calls, 2);
  assert.ok(covered(node));
  assert.equal((await h.message('STATUS')).busy, false);
});

test('threshold changes reuse scores, reveal-all stays paused, and disabling removes covers', async () => {
  const node = new Element('p', passage('threshold'));
  const h = await fixture({nodes: [node], cached: new Map([[node.text, .8]])});
  assert.equal(covered(node), false);
  h.config.threshold = .7; await h.message('CONFIG_CHANGED'); await h.flush();
  assert.ok(covered(node));
  await h.message('REVEAL_ALL');
  h.config.threshold = .6; await h.message('CONFIG_CHANGED'); await h.flush();
  assert.equal(covered(node), false);
  assert.equal((await h.message('STATUS')).paused, true);
  await h.message('RESCAN'); await h.flush();
  assert.ok(covered(node));
  h.config.enabled = false; await h.message('CONFIG_CHANGED'); await h.flush();
  assert.equal(covered(node), false);
  assert.equal(h.detects.length, 0);
});

test('stale cache responses after disable cannot inject covers', async () => {
  const wait = deferred(), node = new Element('p', passage('disable'));
  const h = await fixture({nodes: [node], lookup: () => wait.promise});
  assert.equal(h.detects.length, 0, 'API work waits for its cache probe');
  h.config.enabled = false; await h.message('CONFIG_CHANGED');
  wait.resolve({scores: [.99]}); await h.flush();
  assert.equal(covered(node), false);
  assert.equal(h.detects.length, 0);
});

test('duplicate passages share evaluation and a result is retained after every node disappears', async () => {
  const text = passage('duplicate'), first = new Element('p', text), second = new Element('p', text);
  const wait = deferred();
  const h = await fixture({nodes: [first, second], classify: () => wait.promise});
  assert.equal(h.detects.length, 1);
  assert.equal(h.lookups.flat().length, 1);
  first.remove(); second.remove(); h.mutate(); await h.flush();
  wait.resolve({score: .95, source: 'shared'}); await h.flush();
  assert.equal((await h.message('STATUS')).evaluated, 0);
  h.body.append(first, second); h.mutate(); await h.flush();
  assert.ok(covered(first)); assert.ok(covered(second));
  assert.equal(h.detects.length, 1);
  assert.equal(h.lookups.flat().length, 1);
});

test('a returning cache miss is probed again for scores saved elsewhere', async () => {
  const node = new Element('p', passage('later saved')), cached = new Map();
  const h = await fixture({nodes: [node], cached, limit: 0});
  assert.equal(covered(node), false);
  node.remove(); h.mutate(); await h.flush();
  cached.set(node.text, .99);
  h.body.append(node); h.mutate(); await h.flush();
  assert.ok(covered(node));
  assert.equal(h.lookups.length, 2);
  assert.equal(h.detects.length, 0);
});

test('changing the global rule immediately removes covers and invalidates in-page scores', async () => {
  const node = new Element('p', passage('old cached score')), cached = new Map([[node.text, .99]]);
  const wait = deferred();
  const h = await fixture({nodes: [node], cached, classify: () => wait.promise});
  assert.ok(covered(node));
  cached.clear(); h.config.filterId = 'rule-two';
  await h.message('CONFIG_CHANGED');
  assert.equal(covered(node), false, 'old covers disappear before a new decision arrives');
  await h.flush();
  const requests = h.requests.filter(m => m.type === 'DETECT' || m.type === 'CACHE_LOOKUP');
  assert.equal(requests[0].filterId, 'rule-one');
  assert.ok(requests.slice(1).every(m => m.filterId === 'rule-two'));
  wait.resolve({score: 0, source: 'api'}); await h.flush();
  assert.equal(covered(node), false);
});

test('rule switches discard old pending scores and clear removes all covers', async () => {
  const node = new Element('p', passage('old pending')), wait = deferred();
  let calls = 0;
  const h = await fixture({nodes: [node], classify: () => ++calls === 1 ? wait.promise : {score: 0, source: 'api'}});
  h.config.filterId = 'rule-two'; await h.message('CONFIG_CHANGED'); await h.flush();
  wait.resolve({score: .99, source: 'api'}); await h.flush();
  assert.equal(covered(node), false);
  assert.equal(calls, 2);
  h.config.filterId = null; h.config.configured = false;
  await h.message('CONFIG_CHANGED'); await h.flush();
  assert.equal((await h.message('STATUS')).configured, false);
  assert.equal(h.timers.size, 0);
});

test('short tweets can match a topic while tiny generic interface labels are skipped', async () => {
  const tweet = new Element('div', 'Paris here we come!', {'data-testid': 'tweetText'});
  const label = new Element('p', 'Show replies');
  const h = await fixture({nodes: [tweet, label]});
  assert.deepEqual(h.detects, [tweet.text]);
  assert.ok(covered(tweet)); assert.equal(covered(label), false);
});
