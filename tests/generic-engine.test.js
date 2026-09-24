import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {genericAdaptor} from '../extension/adaptors/generic.js';
import {collectRoots} from '../extension/adaptors/roots.js';

const sourceOf = async path => readFile(new URL(path, import.meta.url), 'utf8');
const contentSource = await sourceOf('../extension/content.js');
const passage = id => `Passage ${id}: The library opens at nine on weekdays, and books can be renewed at the front desk using a library card.`;

// A jsdom page drives the real content script with a hostname, so the fixture
// resolves the generic adaptor exactly as the browser would. The optional
// setup callback attaches shadow roots before the script's first scan.
async function page(html, setup, {url = 'https://example.com/', limit = 120} = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {url, runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  if (setup) setup(w.document, w);
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
      if (message.type === 'DETECT') { detects.push(message.text); return {score: .95, source: 'api'}; }
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
const coverOf = node => node.querySelector('[data-slop-shield="cover"]');

test('collectRoots returns the root plus every reachable open shadow root, depth-first', () => {
  const dom = new JSDOM('<!doctype html><body><p>light</p></body>', {url: 'https://example.com/'});
  const d = dom.window.document;
  const host = d.createElement('div'); d.body.append(host);
  const openRoot = host.attachShadow({mode: 'open'});
  openRoot.innerHTML = '<p>open</p>';
  const nestedHost = d.createElement('div'); openRoot.append(nestedHost);
  const nestedRoot = nestedHost.attachShadow({mode: 'open'});
  nestedRoot.innerHTML = '<p>nested</p>';
  const closedHost = d.createElement('div'); d.body.append(closedHost);
  closedHost.attachShadow({mode: 'closed'}).innerHTML = '<p>closed</p>';
  // Closed roots report shadowRoot === null and are skipped without throwing;
  // open roots follow the document, nested roots follow their parents.
  assert.deepEqual(collectRoots(d), [d, openRoot, nestedRoot]);
  dom.window.close();
});

test('a candidate inside an open shadow root is discovered and covered per-passage', async t => {
  let openRoot, nestedRoot;
  const p = await page(`<p>${passage('light')}</p>`, d => {
    const host = d.createElement('div'); d.body.append(host);
    openRoot = host.attachShadow({mode: 'open'});
    openRoot.innerHTML = `<p>${passage('open shadow')}</p>`;
    const nestedHost = d.createElement('div'); openRoot.append(nestedHost);
    nestedRoot = nestedHost.attachShadow({mode: 'open'});
    nestedRoot.innerHTML = `<p>${passage('nested shadow')}</p>`;
  });
  t.after(p.close);
  assert.ok(p.detects.includes(passage('open shadow')), 'the open shadow root passage must be discovered');
  assert.ok(p.detects.includes(passage('nested shadow')), 'a passage in a nested open shadow root must be discovered');
  assert.ok(p.detects.includes(passage('light')));
  // Generic grouping is per-passage: each cover sits on its own passage node,
  // including passages inside shadow roots.
  const openP = openRoot.querySelector('p'), nestedP = nestedRoot.querySelector('p'), lightP = p.doc.querySelector('p');
  assert.equal(coverOf(openP).parentElement, openP);
  assert.equal(coverOf(nestedP).parentElement, nestedP);
  assert.equal(coverOf(lightP).parentElement, lightP);
  assert.equal((await p.send('STATUS')).covered, 3);
});

test('a closed shadow root is skipped silently and never blocks other candidates', async t => {
  let closedRoot;
  const p = await page(`<p>${passage('light')}</p>`, d => {
    const host = d.createElement('div'); d.body.append(host);
    closedRoot = host.attachShadow({mode: 'closed'});
    closedRoot.innerHTML = `<p>${passage('closed shadow')}</p>`;
  });
  t.after(p.close);
  assert.ok(p.detects.includes(passage('light')), 'other candidates keep flowing past the closed root');
  assert.equal(p.detects.includes(passage('closed shadow')), false);
  assert.equal((await p.send('STATUS')).error, '');
  // Repeated scans over the closed host stay silent and reuse the cached score.
  await p.send('RESCAN'); await p.settle();
  assert.deepEqual(p.detects, [passage('light')]);
});

test('a content dialog is a candidate surface under the neutral dialog policy', async t => {
  const lightbox = `Passage lightbox: The museum's winter exhibition traces trade routes across three continents through rare manuscripts and maps.`;
  const p = await page(`<div role="dialog" aria-label="Article preview"><p>${lightbox}</p></div>`);
  t.after(p.close);
  const paragraph = p.doc.querySelector('[role="dialog"] p');
  assert.ok(p.detects.includes(lightbox), 'the lightbox passage must be discovered');
  assert.equal(coverOf(paragraph).parentElement, paragraph);
});

test('interface dialogs built on forms and textboxes stay excluded', async t => {
  const login = 'Passage login: Enter the email address associated with your account to continue to the secure sign-in page.';
  const cookie = 'Passage cookie: We use cookies to personalize content and to measure how visitors move through the site across sessions.';
  const p = await page(`
    <div role="dialog" aria-label="Sign in">
      <form>
        <p>${login}</p>
        <input type="email">
        <button type="submit">Continue</button>
      </form>
    </div>
    <div role="dialog" aria-label="Cookie consent">
      <form>
        <label>${cookie}</label>
        <textarea></textarea>
        <button>Accept all</button>
      </form>
    </div>`);
  t.after(p.close);
  assert.deepEqual(p.detects, []);
  assert.equal(p.doc.querySelectorAll('[data-slop-shield="cover"]').length, 0);
});

test('shadow traversal is the generic adaptor opt-in; site adaptors keep scanning the document', async t => {
  let openRoot;
  const p = await page(`<p>${passage('light')}</p>`, d => {
    const host = d.createElement('div'); d.body.append(host);
    openRoot = host.attachShadow({mode: 'open'});
    openRoot.innerHTML = `<p>${passage('open shadow')}</p>`;
  }, {url: 'https://x.com/'});
  t.after(p.close);
  assert.ok(p.detects.includes(passage('light')));
  assert.equal(p.detects.includes(passage('open shadow')), false, 'the x adaptor does not opt into shadow roots');
  assert.equal(coverOf(openRoot), null);
});

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

test('the inline traversal copies behave identically to the canonical collectRoots', async () => {
  const runtime = await runtimeAdaptors();
  const dom = new JSDOM('<!doctype html><body></body>', {url: 'https://example.com/'});
  const d = dom.window.document;
  const host = d.createElement('div'); d.body.append(host);
  const openRoot = host.attachShadow({mode: 'open'});
  openRoot.innerHTML = '<p>open</p>';
  const nestedHost = d.createElement('div'); openRoot.append(nestedHost);
  const nestedRoot = nestedHost.attachShadow({mode: 'open'});
  nestedRoot.innerHTML = '<p>nested</p>';
  const closedHost = d.createElement('div'); d.body.append(closedHost);
  closedHost.attachShadow({mode: 'closed'}).innerHTML = '<p>closed</p>';
  const expected = [d, openRoot, nestedRoot];
  assert.deepEqual([...collectRoots(d)], expected);
  assert.deepEqual([...genericAdaptor.roots(d)], expected, 'the generic module copy must match the canonical traversal');
  assert.deepEqual([...runtime.generic.roots(d)], expected, 'the content.js mirror must match the canonical traversal');
  dom.window.close();
});
