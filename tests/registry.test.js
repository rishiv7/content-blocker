import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {adaptorFor} from '../extension/adaptors/registry.js';
import {xAdaptor} from '../extension/adaptors/x.js';
import {redditAdaptor} from '../extension/adaptors/reddit.js';
import {genericAdaptor} from '../extension/adaptors/generic.js';

const sourceOf = async path => readFile(new URL(path, import.meta.url), 'utf8');
const contentSource = await sourceOf('../extension/content.js');
const modules = {x: xAdaptor, reddit: redditAdaptor, generic: genericAdaptor};

test('registry maps hostnames to site adaptors and falls back to generic', () => {
  assert.equal(adaptorFor('x.com').id, 'x');
  assert.equal(adaptorFor('twitter.com').id, 'x');
  assert.equal(adaptorFor('mobile.twitter.com').id, 'x');
  assert.equal(adaptorFor('sub.x.com').id, 'x');
  assert.equal(adaptorFor('reddit.com').id, 'reddit');
  assert.equal(adaptorFor('old.reddit.com').id, 'reddit');
  // The LinkedIn adaptor lands with its own PR; generic serves linkedin.com.
  assert.equal(adaptorFor('linkedin.com').id, 'generic');
  assert.equal(adaptorFor('example.com').id, 'generic');
  assert.equal(adaptorFor('').id, 'generic');
  // Look-alike hosts must not resolve to a site adaptor.
  assert.equal(adaptorFor('notx.com').id, 'generic');
  assert.equal(adaptorFor('x.company').id, 'generic');
  assert.equal(adaptorFor('reddit.com.br').id, 'generic');
});

test('registry is total: every hostname resolves to an adaptor, never undefined', () => {
  for (const hostname of ['x.com', 'reddit.com', 'linkedin.com', 'example.com', '', 'localhost', 'a.b.c.d', 'X.COM']) {
    const adaptor = adaptorFor(hostname.toLowerCase());
    assert.ok(adaptor, `no adaptor for ${JSON.stringify(hostname)}`);
    assert.equal(typeof adaptor.candidates, 'string');
  }
});

test('adaptor modules are pure: no browser APIs, classification, or persistence', async () => {
  const registry = await sourceOf('../extension/adaptors/registry.js');
  for (const [id, adaptor] of Object.entries(modules)) {
    const source = await sourceOf(`../extension/adaptors/${id}.js`);
    assert.doesNotMatch(source, /\bchrome\b|\bjev\b|\bstorage\b/, `${id} adaptor references a forbidden API`);
    assert.doesNotMatch(source, /^\s*import\b/m, `${id} adaptor must not import anything`);
  }
  assert.doesNotMatch(registry, /\bchrome\b|\bjev\b|\bstorage\b/, 'registry references a forbidden API');
  const imports = [...registry.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./generic.js', './reddit.js', './x.js']);
});

test('every adaptor exposes the discovery contract and reserves the optional hooks', () => {
  for (const adaptor of [xAdaptor, redditAdaptor]) {
    assert.equal(typeof adaptor.id, 'string');
    assert.equal(typeof adaptor.matches, 'function');
    assert.ok(adaptor.candidates.length > 0);
    assert.ok(adaptor.exclude.length > 0);
    assert.equal(typeof adaptor.targetOf, 'function');
    assert.equal(typeof adaptor.minText, 'function');
    assert.equal(typeof adaptor.eligible, 'function');
    assert.equal(typeof adaptor.container, 'string');
    // No adaptor carries budget-shaped configuration, a dialog opt-in, or an
    // observation override.
    assert.equal(adaptor.dialogOptIn, undefined);
    assert.equal(adaptor.observe, undefined);
  }
  // X keeps every reserved hook unset.
  assert.equal(xAdaptor.roots, undefined);
  assert.deepEqual(Object.keys(xAdaptor).sort(),
    ['candidates', 'container', 'eligible', 'exclude', 'id', 'matches', 'minText', 'targetOf']);
  // The reddit adaptor consumes the reserved roots hook: shreddit discovery
  // scans every reachable open shadow root.
  assert.equal(typeof redditAdaptor.roots, 'function');
  assert.deepEqual(Object.keys(redditAdaptor).sort(),
    ['candidates', 'container', 'eligible', 'exclude', 'id', 'matches', 'minText', 'roots', 'targetOf']);
  // The generic adaptor opts into open-shadow traversal through the roots
  // hook (the universal engine); dialog neutrality is expressed by its
  // exclusion list, not a hook.
  assert.equal(typeof genericAdaptor.roots, 'function');
  assert.equal(genericAdaptor.dialogOptIn, undefined);
  assert.equal(genericAdaptor.observe, undefined);
  assert.deepEqual(Object.keys(genericAdaptor).sort(),
    ['candidates', 'container', 'eligible', 'exclude', 'id', 'matches', 'minText', 'roots', 'targetOf']);
});

test('x and generic carry the shipped sets verbatim; reddit gains shreddit boundaries', () => {
  const shipped = 'p, li, blockquote, [data-testid="tweetText"], [data-ad-preview="message"], .md > div, div[dir="auto"]';
  const shippedExclude = 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [aria-hidden="true"], [hidden], [data-slop-shield]';
  assert.equal(xAdaptor.candidates, shipped);
  assert.equal(xAdaptor.exclude, shippedExclude);
  // The reddit coverage PR curates the candidate set for this origin: the
  // old-UI prose selectors stay, the tweet-shaped hooks drop, and shreddit's
  // stable slots (detail title, comment body) join. The exclusion set stays
  // shipped verbatim.
  assert.equal(redditAdaptor.candidates, 'p, li, blockquote, .md > div, div[dir="auto"], h1[slot="title"], div[slot="comment"]');
  assert.equal(redditAdaptor.exclude, shippedExclude);
  // The universal engine evolves the generic adaptor only: the shipped
  // candidate set stays, and the blanket [role="dialog"] exclusion is dropped
  // (neutral dialog policy) while every structural chrome exclusion remains.
  assert.equal(genericAdaptor.candidates, shipped);
  assert.equal(genericAdaptor.exclude,
    'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [aria-hidden="true"], [hidden], [data-slop-shield]');
});

// content.js is injected as a classic script, so it cannot import the adaptor
// modules; it mirrors them inline. Running the script in a stub sandbox exposes
// the mirror for this audit.
const normalizeFn = fn => String(fn).replace(/\s+/g, ' ').trim();

async function runtimeAdaptors() {
  const sandbox = {
    chrome: {runtime: {sendMessage: async () => { throw new Error('offline'); }, onMessage: {addListener: () => {}}}},
    document: {addEventListener: () => {}},
    addEventListener: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(contentSource, sandbox);
  return sandbox.__slopShieldAdaptors;
}

test('content.js mirrors the adaptor modules (whitespace-insensitive)', async () => {
  const runtime = await runtimeAdaptors();
  for (const [id, module] of Object.entries(modules)) {
    const mirror = runtime[id];
    assert.ok(mirror, `content.js does not expose the ${id} adaptor`);
    assert.equal(mirror.id, module.id);
    assert.equal(mirror.candidates, module.candidates);
    assert.equal(mirror.exclude, module.exclude);
    assert.equal(mirror.container, module.container);
    for (const key of ['matches', 'targetOf', 'minText', 'eligible'])
      assert.equal(normalizeFn(mirror[key]), normalizeFn(module[key]), `${id}.${key} drifted from the canonical module`);
  }
  assert.equal(normalizeFn(runtime.adaptorFor), normalizeFn(adaptorFor));
  // The runtime registry resolves like the canonical one.
  assert.equal(runtime.adaptorFor('x.com').id, 'x');
  assert.equal(runtime.adaptorFor('reddit.com').id, 'reddit');
  assert.equal(runtime.adaptorFor('linkedin.com').id, 'generic');
  assert.equal(runtime.adaptorFor('example.com').id, 'generic');
});

const passage = id => `Passage ${id}: The library opens at nine on weekdays, and books can be renewed at the front desk using a library card.`;

// A jsdom page drives the real content script with a hostname, so the fixture
// resolves the x, reddit, or generic adaptor exactly as the browser would.
async function page(html, {url = 'https://example.com/', limit = 120} = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {url, runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  const timers = new Map();
  let timerId = 0, listener = null;
  const detects = [];
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {get() { return this.textContent; }});
  w.HTMLElement.prototype.getBoundingClientRect = function() {
    return this.closest('#far') ? {width: 500, height: 300, top: 100000, left: 0, right: 500, bottom: 100300}
      : {width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300};
  };
  w.chrome = {runtime: {
    sendMessage: async message => {
      if (message.type === 'CONFIG') return {enabled: true, configured: true, threshold: .85, limit, filterId: 'rule-one'};
      if (message.type === 'CACHE_LOOKUP') return {scores: message.texts.map(() => null)};
      if (message.type === 'DETECT') { detects.push(message.text); return {score: 0, source: 'api'}; }
      throw new Error('Unexpected message');
    },
    onMessage: {addListener: fn => { listener = fn; }}
  }};
  w.setTimeout = fn => { timers.set(++timerId, fn); return timerId; };
  w.clearTimeout = id => timers.delete(id);
  w.eval(contentSource);
  const settle = async () => {
    for (let i = 0; i < 20000; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (!timers.size) return;
      const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn());
    }
    throw new Error('Scan did not settle (possible scheduling loop)');
  };
  const send = type => new Promise(resolve => listener({type}, {}, resolve));
  await settle();
  return {w, doc: w.document, detects, settle, send, close: () => w.close()};
}

test('a 500-candidate page caps evaluations at the budget with distance priority on every adaptor', async () => {
  const near = Array.from({length: 120}, (_, i) => `<p>${passage(`near ${i}`)}</p>`).join('');
  const far = `<div id="far">${Array.from({length: 380}, (_, i) => `<p>${passage(`far ${i}`)}</p>`).join('')}</div>`;
  const nearTexts = new Set(Array.from({length: 120}, (_, i) => passage(`near ${i}`)));
  for (const url of ['https://x.com/', 'https://reddit.com/', 'https://example.com/']) {
    const p = await page(near + far, {url});
    const status = await p.send('STATUS');
    assert.equal(status.evaluated, 120, `${url} must stop at the page budget`);
    assert.equal(status.limit, true, `${url} must report its budget as reached`);
    assert.equal(p.detects.length, 120);
    assert.ok(p.detects.every(text => nearTexts.has(text)), `${url} must evaluate near-viewport passages first`);
    p.close();
  }
});

test('no adaptor can raise the configured page budget', async () => {
  const html = Array.from({length: 500}, (_, i) => `<p>${passage(i)}</p>`).join('');
  for (const url of ['https://x.com/', 'https://reddit.com/', 'https://example.com/']) {
    const p = await page(html, {url, limit: 5});
    assert.equal((await p.send('STATUS')).evaluated, 5, `${url} must honor the configured limit exactly`);
    p.close();
  }
});

test('background budgets stay adaptor-free', async () => {
  const source = await sourceOf('../extension/background.js');
  assert.doesNotMatch(source, /adaptors\//, 'the background worker must not consume adaptor modules');
  assert.match(source, /limit: 120/);
  assert.match(source, /network\.size >= 4/);
  assert.match(source, /quota\.count >= 360/);
});
