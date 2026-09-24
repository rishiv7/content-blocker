import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

// LinkedIn per-surface fixtures (spec criterion 3): feed, post detail, and
// search results, driven through the real content script with the linkedin
// adaptor resolved from the page hostname. Selectors are pinned against these
// structural fixtures — LinkedIn gates logged-in DOM, so no live-DOM claims
// are made here; the PR body documents provenance.
const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

// A jsdom page drives the real content script at a linkedin.com URL, so the
// fixture resolves the linkedin adaptor exactly as the browser would. Cache
// mode seeds scores (default .95 = flagged) so covers exercise the cache path
// deterministically; cache-miss mode routes through the single-flight DETECT
// path to expose budget accounting.
async function page(html, {values = {}, limit = 120, cacheMiss = false} = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {url: 'https://www.linkedin.com/feed/', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  const timers = new Map();
  let timerId = 0, listener = null;
  const config = {enabled: true, configured: true, threshold: .85, limit, filterId: 'rule1'};
  const detects = [];
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {get() { return this.textContent; }});
  w.HTMLElement.prototype.getBoundingClientRect = () => ({width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300});
  const style = w.getComputedStyle.bind(w);
  w.getComputedStyle = node => { const result = style(node); if (!result.position) result.position = 'static'; return result; };
  w.chrome = {runtime: {
    sendMessage: async message => {
      if (message.type === 'CONFIG') return {...config};
      if (message.type === 'CACHE_LOOKUP') return {scores: message.texts.map(text => cacheMiss ? null : (values[text] ?? .95))};
      if (message.type === 'DETECT') { detects.push(message.text); return {score: values[message.text] ?? .95, source: 'api'}; }
      throw new Error('Unexpected message');
    },
    onMessage: {addListener(fn) { listener = fn; }}
  }};
  w.setTimeout = fn => { timers.set(++timerId, fn); return timerId; };
  w.clearTimeout = id => timers.delete(id);
  w.eval(script);
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
  return {w, doc: w.document, config, detects, settle, send, close: () => w.close()};
}
const covers = node => node.querySelectorAll('[data-slop-shield="cover"]');

// Structural feed-post fixture: an update wrapper (data-urn) holding an
// article region with the post's bidi text block and, optionally, media.
const feedPost = (id, text) => `
  <div data-urn="urn:li:activity:${id}" id="post-${id}">
    <div role="article">
      <span dir="auto">${text}</span>
      <img src="https://example.com/${id}.jpg" alt="post media">
    </div>
  </div>`;

test('flagged feed post covers its text container; the attached image stays visible', async t => {
  const p = await page(
    feedPost('701', 'The team is shipping a new verification flow and we are hiring engineers to help us build it this quarter.') +
    feedPost('702', 'Neighborhood bakery returns to the market square this weekend with sourdough loaves.'),
    {values: {'Neighborhood bakery returns to the market square this weekend with sourdough loaves.': .1}});
  t.after(p.close);
  const flagged = p.doc.getElementById('post-701'), allowed = p.doc.getElementById('post-702');
  // The cover lands on the post's text container — the bidi block — not on
  // the whole card, so the image beside the flagged text stays visible.
  assert.equal(covers(flagged).length, 1);
  assert.equal(covers(flagged)[0].parentElement, flagged.querySelector('span[dir="auto"]'));
  assert.equal(flagged.querySelector('img').closest('[data-slop-shield="cover"]'), null);
  assert.equal(covers(allowed).length, 0);
  assert.equal((await p.send('STATUS')).covered, 1);
});

test('a text block carrying media is scored — the shipped media drop no longer applies', async t => {
  const p = await page('<div dir="auto" id="caption-block">Launch day walkthrough of the new pipeline with the full demo attached below for the team.<img src="https://example.com/demo.jpg"></div>');
  t.after(p.close);
  // Under the shipped policy any candidate holding an img was never scored;
  // the linkedin media policy keeps text blocks with media eligible.
  assert.equal(covers(p.doc.getElementById('caption-block')).length, 1);
});

test('post-detail modal prose is discovered — no blanket dialog exclusion', async t => {
  const p = await page(`
    <div role="dialog" aria-label="Post detail" id="detail-modal">
      <span dir="auto">Full post detail text about the migration story from the conference talk last spring.</span>
      <img src="https://example.com/modal.jpg">
    </div>`);
  t.after(p.close);
  // The feed's post-detail surface is a [role="dialog"] modal; the linkedin
  // adaptor opts into dialog content, so its prose is a candidate surface.
  assert.equal(covers(p.doc.getElementById('detail-modal')).length, 1);
});

test('search-result snippets are discovered as their own text containers', async t => {
  const p = await page(`
    <ul id="results">
      <li id="result-1">
        <a href="https://www.linkedin.com/in/dana"><span dir="auto">Dana Whitfield — Principal Engineer at Meridian Labs in Amsterdam</span></a>
        <span dir="auto">Wrote about distributed tracing, on-call rotations, and the craft of incident reviews.</span>
      </li>
      <li id="result-2">
        <span dir="auto">Hiring pipelines in the region grew this quarter according to the platform report.</span>
      </li>
    </ul>`);
  t.after(p.close);
  const first = p.doc.getElementById('result-1'), second = p.doc.getElementById('result-2');
  assert.equal(covers(first).length, 1);
  assert.equal(covers(first)[0].parentElement, first.querySelectorAll('span[dir="auto"]')[1]);
  assert.equal(covers(second).length, 1);
  // A result title anchor-wrapped into a link is interface navigation under
  // the shipped core link rule (candidates inside a/button are never scored);
  // that boundary is core-owned, not adaptor policy.
  assert.equal(covers(first.querySelector('a')).length, 0);
});

test('interface chrome stays outside discovery: nav links, composer, form, short labels', async t => {
  const p = await page(`
    <nav id="nav"><a href="/feed"><span dir="auto">Home Feed My Jobs messaging navigation label text</span></a></nav>
    <div role="textbox" contenteditable="true" id="composer"><span dir="auto">Draft comment text sitting inside the composer box here.</span></div>
    <form id="search-form"><span dir="auto">Search helper prose inside the header form region here.</span></form>
    <span dir="auto">Like</span>`);
  t.after(p.close);
  // Nothing on the page is a legitimate candidate: every cover count is zero
  // (and the short button label additionally fails the 20-char minimum).
  assert.equal(covers(p.doc).length, 0);
});

test('a 500-candidate feed caps evaluations at the page budget', async t => {
  const html = Array.from({length: 500}, (_, i) => `<p>Passage ${i}: The library opens at nine on weekdays, and books can be renewed at the front desk using a library card.</p>`).join('');
  const p = await page(html, {cacheMiss: true});
  t.after(p.close);
  const status = await p.send('STATUS');
  assert.equal(status.evaluated, 120, 'linkedin must stop at the page budget');
  assert.equal(status.limit, true, 'linkedin must report its budget as reached');
  assert.equal(p.detects.length, 120);
});
