import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {xAdaptor} from '../extension/adaptors/x.js';

const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

// Per-surface X fixtures drive the real content script on x.com URLs, following
// the DOM-testing pattern of tests/registry.test.js and tests/tweet-cover.test.js.
// Live-DOM pinning was not possible this session: x.com serves HTTP 403 to this
// environment's browser and gates explore/search/profile behind login, so these
// fixtures pin the structural contract (X's stable data-testids, role="dialog")
// rather than a DOM snapshot.
async function page(html, {url = 'https://x.com/home', values = {}} = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {url, runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  const timers = new Map();
  let timerId = 0, listener = null;
  const detects = [];
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {get() { return this.textContent; }});
  w.HTMLElement.prototype.getBoundingClientRect = function() {
    return {width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300};
  };
  const computed = w.getComputedStyle.bind(w);
  w.getComputedStyle = node => { const result = computed(node); if (!result.position) result.position = 'static'; return result; };
  w.chrome = {runtime: {
    sendMessage: async message => {
      if (message.type === 'CONFIG') return {enabled: true, configured: true, threshold: .85, limit: 120, filterId: 'rule-one'};
      if (message.type === 'CACHE_LOOKUP') return {scores: message.texts.map(text => values[text] ?? null)};
      if (message.type === 'DETECT') { detects.push(message.text); return {score: .95, source: 'api'}; }
      throw new Error('Unexpected message');
    },
    onMessage: {addListener: fn => { listener = fn; }}
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
  return {w, doc: w.document, detects, settle, send, close: () => w.close()};
}

const covers = node => node.querySelectorAll('[data-slop-shield="cover"]');
const directCovers = node => [...node.children].filter(child => child.dataset?.slopShield === 'cover');
const passage = id => `${id}: The library opens at nine on weekdays, and books can be renewed at the front desk using a library card.`;

test('feed: flagged tweets cover their articles, media tweets included, within budget', async t => {
  const html = `<div data-testid="primaryColumn">
    <article data-testid="tweet" id="plain"><div data-testid="tweetText">${passage('feed plain')}</div></article>
    <article data-testid="tweet" id="media"><div data-testid="tweetText">${passage('feed media')}</div><div data-testid="tweetPhoto"><img src="https://example.com/media.jpg" alt="rally"></div></article>
    <article data-testid="tweet" id="fine"><div data-testid="tweetText">${passage('feed fine')}</div></article>
  </div>`;
  const p = await page(html, {values: {[passage('feed fine')]: .1}}); t.after(p.close);
  for (const id of ['plain', 'media']) {
    const article = p.doc.getElementById(id);
    assert.equal(covers(article).length, 1, `${id} must be covered`);
    assert.equal(covers(article)[0].parentElement, article, `${id} must carry the shipped article grouping`);
  }
  assert.equal(covers(p.doc.getElementById('fine')).length, 0);
  const status = await p.send('STATUS');
  assert.equal(status.covered, 2);
  assert.ok(status.evaluated <= 120, 'evaluations must stay within the page budget');
  assert.equal(status.limit, false, 'a small feed must not exhaust the budget');
});

test('reply threads: each flagged reply covers its own article', async t => {
  const html = `<div data-testid="primaryColumn">
    <article data-testid="tweet" id="root"><div data-testid="tweetText">${passage('root tweet')}</div></article>
    <div data-testid="cellInnerDiv"><article data-testid="tweet" id="reply1"><div data-testid="tweetText">${passage('reply one')}</div></article></div>
    <div data-testid="cellInnerDiv"><article data-testid="tweet" id="reply2"><div data-testid="tweetText">${passage('reply two')}</div></article></div>
  </div>`;
  const p = await page(html, {url: 'https://x.com/nasa/status/20', values: {[passage('reply two')]: .1}}); t.after(p.close);
  assert.equal(covers(p.doc.getElementById('root')).length, 1);
  assert.equal(covers(p.doc.getElementById('reply1')).length, 1, 'a flagged reply must cover its own article');
  assert.equal(covers(p.doc.getElementById('reply2')).length, 0);
  assert.equal((await p.send('STATUS')).covered, 2);
});

test('photo modal: caption covered on the caption element; modal chrome stays clear', async t => {
  const html = `
    <article data-testid="tweet" id="behind"><div data-testid="tweetText">${passage('behind modal')}</div></article>
    <div role="dialog" aria-label="Image" id="modal">
      <button id="close">Close</button>
      <div data-testid="tweetPhoto"><img src="https://example.com/modal.jpg"></div>
      <article data-testid="tweet" id="modal-tweet">
        <div data-testid="tweetText" id="caption">${passage('modal caption')}</div>
        <div role="group" aria-label="Engagement actions"><button id="like">Like</button><button id="reply-btn">Reply</button></div>
      </article>
    </div>`;
  const p = await page(html, {url: 'https://x.com/nasa/status/20/photo', values: {[passage('modal caption')]: .95}}); t.after(p.close);
  const caption = p.doc.getElementById('caption'), article = p.doc.getElementById('modal-tweet');
  assert.equal(covers(caption).length, 1, 'the modal caption must be discovered and covered');
  assert.equal(covers(caption)[0].parentElement, caption, 'the cover must overlay the caption itself, not the surrounding article');
  assert.equal(directCovers(article).length, 0, 'the modal article must not carry the cover');
  for (const id of ['close', 'like', 'reply-btn'])
    assert.equal(covers(p.doc.getElementById(id)).length, 0, `${id} chrome must stay uncovered`);
  assert.equal(covers(p.doc.getElementById('behind')).length, 1, 'feed-style grouping is unchanged outside dialogs');
  assert.equal(covers(p.doc.getElementById('behind'))[0].parentElement, p.doc.getElementById('behind'));
  assert.equal((await p.send('STATUS')).covered, 2);
});

test('modal captions can be short: tweetText reaches Jev from a single character', async t => {
  const html = `<div role="dialog" aria-label="Image"><article data-testid="tweet"><div data-testid="tweetText" id="short">Huge crowd!</div></article></div>`;
  const p = await page(html, {url: 'https://x.com/nasa/status/20/photo'}); t.after(p.close);
  assert.ok(p.detects.includes('Huge crowd!'), 'a short modal caption must be discovered and sent to Jev');
  assert.equal(covers(p.doc.getElementById('short')).length, 1);
});

test('search results: flagged hits cover their articles; people results stay passage-level', async t => {
  const html = `<div data-testid="primaryColumn">
    <article data-testid="tweet" id="hit"><div data-testid="tweetText">${passage('search hit')}</div></article>
    <article data-testid="tweet" id="miss"><div data-testid="tweetText">${passage('search miss')}</div></article>
    <div data-testid="cellInnerDiv"><div dir="auto" id="bio">${passage('person bio')}</div></div>
  </div>`;
  const p = await page(html, {url: 'https://x.com/search?q=library', values: {[passage('search miss')]: .1, [passage('person bio')]: .1}}); t.after(p.close);
  assert.equal(covers(p.doc.getElementById('hit')).length, 1);
  assert.equal(covers(p.doc.getElementById('miss')).length, 0);
  assert.equal(covers(p.doc.getElementById('bio')).length, 0, 'a non-tweet passage keeps its per-passage grouping');
  assert.equal((await p.send('STATUS')).checked, 3);
});

test('profile timelines: bio, tweets, and media tweets discover; nav chrome is never queried', async t => {
  const html = `<div data-testid="primaryColumn">
    <div dir="auto" id="bio">${passage('profile bio')}</div>
    <article data-testid="tweet" id="ptext"><div data-testid="tweetText">${passage('profile tweet')}</div></article>
    <article data-testid="tweet" id="pmedia"><div data-testid="tweetText">${passage('profile media')}</div><div data-testid="tweetPhoto"><img src="https://example.com/p.jpg"></div></article>
  </div>
  <nav><div dir="auto">${passage('nav label')}</div></nav>`;
  const p = await page(html, {url: 'https://x.com/nasa', values: {[passage('profile bio')]: .1}}); t.after(p.close);
  assert.equal(covers(p.doc.getElementById('bio')).length, 0);
  assert.equal(covers(p.doc.getElementById('ptext')).length, 1);
  assert.equal(covers(p.doc.getElementById('pmedia')).length, 1);
  assert.ok(!p.detects.some(text => text.includes(passage('nav label'))), 'nav passages must not be discovered');
});

test('media-bearing tweet text is scored and covered (the shipped media policy skipped it)', async t => {
  const flaggedText = `${passage('quoted media')} ${passage('quoted inner')}`;
  const html = `<article data-testid="tweet" id="quoted">
    <div data-testid="tweetText" id="qtext">${passage('quoted media')} <blockquote><div dir="auto">${passage('quoted inner')}</div><div data-testid="tweetPhoto"><img src="https://example.com/q.jpg"></div></blockquote></div>
  </article>`;
  const p = await page(html, {values: {[flaggedText]: .95}}); t.after(p.close);
  const article = p.doc.getElementById('quoted');
  assert.equal(covers(article).length, 1, 'a tweetText holding media must be discovered and covered');
  assert.equal(covers(article)[0].parentElement, article);
  assert.ok(!p.detects.includes(flaggedText), 'the flag came from the score cache');
});

test('media targetOf mapping: text-bearing wrappers cover their passage; media-only ones cover the media container', () => {
  const dom = new JSDOM('<div id="root"><div dir="auto" id="photo-wrap"><div data-testid="tweetPhoto" id="photo"><img src="https://example.com/a.jpg"></div></div><div dir="auto" id="video-wrap"><div data-testid="videoPlayer" id="player"><video></video></div></div><div dir="auto" id="text-wrap">Text next to the picture<img src="https://example.com/b.jpg"></div></div>', {url: 'https://x.com/'});
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {get() { return this.textContent; }});
  const doc = dom.window.document;
  assert.equal(xAdaptor.targetOf(doc.getElementById('photo-wrap')), doc.getElementById('photo'));
  assert.equal(xAdaptor.targetOf(doc.getElementById('video-wrap')), doc.getElementById('player'));
  assert.equal(xAdaptor.targetOf(doc.getElementById('text-wrap')), doc.getElementById('text-wrap'), 'a flag earned by text covers the passage itself');
});

test('interface dialogs stay clear: chrome inside a dialog is never discovered', async t => {
  const html = `<div role="dialog" aria-label="Sign in" id="signin">
    <nav><div dir="auto">${passage('dialog nav')}</div></nav>
    <input type="text">
    <button id="next">Next</button>
    <div role="textbox" contenteditable="true" id="composer"></div>
    <div aria-hidden="true"><div dir="auto">${passage('hidden promo')}</div></div>
  </div>`;
  const p = await page(html, {url: 'https://x.com/i/flow/login'}); t.after(p.close);
  assert.deepEqual(p.detects, [], 'interface passages inside a dialog must never be discovered');
  assert.equal(covers(p.doc.getElementById('signin')).length, 0);
  assert.equal((await p.send('STATUS')).covered, 0);
});
