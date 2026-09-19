import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const tweet = (id, text) => `<article data-testid="tweet" id="${id}"><div data-testid="tweetText">${text}</div><div data-testid="tweetPhoto"><img src="https://example.com/${id}.jpg"></div></article>`;
async function page(html, values = {}) {
  const dom = new JSDOM(html, {url: 'https://x.com/home', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window, roots = new WeakMap(); let listener;
  const config = {enabled: true, configured: true, threshold: .85, limit: 120, filterId: 'rule1'};
  const requests = [];
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {get() {return this.textContent;}});
  w.HTMLElement.prototype.getBoundingClientRect = () => ({width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300});
  const style = w.getComputedStyle.bind(w);
  w.getComputedStyle = node => {const result = style(node); if (!result.position) result.position = 'static'; return result;};
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function(options) {const root = attach.call(this, options); roots.set(this, root); return root;};
  w.chrome = {runtime: {
    sendMessage: async message => {
      requests.push(message);
      if (message.type === 'CONFIG') return {...config};
      if (message.type === 'CACHE_LOOKUP') return {scores: message.texts.map(text => values[text] ?? .95)};
      if (message.type === 'DETECT') return {score: .95, source: 'api'};
      throw new Error('Unexpected message');
    },
    onMessage: {addListener(fn) {listener = fn;}}
  }};
  w.eval(script);
  const settle = async () => {for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));};
  const send = type => new Promise(resolve => listener({type}, {}, resolve));
  await settle();
  return {w, doc: w.document, roots, config, requests, settle, send, close: () => w.close()};
}
const covers = node => node.querySelectorAll('[data-slop-shield="cover"]');

test('flagged tweet covers the full article and images; adjacent allowed tweet remains visible', async t => {
  const p = await page(tweet('blocked', 'Travel deal') + tweet('allowed', 'Local news'), {'Local news': .1}); t.after(p.close);
  const blocked = p.doc.getElementById('blocked');
  assert.equal(covers(blocked).length, 1);
  const host = covers(blocked)[0];
  assert.equal(host.parentElement, blocked);
  assert.equal(host.style.position, 'absolute'); assert.equal(parseFloat(host.style.inset), 0);
  assert.equal(blocked.style.position, 'relative');
  assert.equal(covers(p.doc.getElementById('allowed')).length, 0);
  assert.match(p.roots.get(host).querySelector('button').getAttribute('aria-label'), /tweet and attached images/);
  assert.equal((await p.send('STATUS')).covered, 1);
  assert.equal(p.requests.some(r => r.type === 'DETECT'), false);
});

test('one reveal uncovers text and images for multiple flagged passages in a tweet', async t => {
  const p = await page('<article id="shared"><div data-testid="tweetText">Travel deal</div><div data-testid="tweetText">Another trip</div><img src="https://example.com/a.jpg"></article>'); t.after(p.close);
  const article = p.doc.getElementById('shared');
  assert.equal(covers(article).length, 1);
  p.roots.get(covers(article)[0]).querySelector('button').click();
  await p.settle();
  assert.equal(covers(article).length, 0);
  assert.equal(article.style.position, '');
  await p.send('RESCAN'); await p.settle();
  assert.equal(covers(article).length, 1);
});

test('late-loaded images remain underneath the same full-tweet cover without another evaluation', async t => {
  const p = await page('<article id="late"><div data-testid="tweetText">Travel deal</div></article>'); t.after(p.close);
  const article = p.doc.getElementById('late'), host = covers(article)[0];
  const image = p.doc.createElement('img'); image.src = 'https://example.com/late.jpg'; article.append(image);
  await p.settle();
  assert.equal(covers(article)[0], host); assert.equal(host.parentElement, image.parentElement);
  assert.equal(p.requests.filter(r => r.type === 'CACHE_LOOKUP').length, 1);
});

test('recycled tweet text removes the old cover and does not hide allowed replacement images', async t => {
  const p = await page(tweet('recycled', 'Travel deal'), {'Local news': .1}); t.after(p.close);
  const article = p.doc.getElementById('recycled');
  article.querySelector('[data-testid="tweetText"]').textContent = 'Local news';
  article.querySelector('img').src = 'https://example.com/news.jpg';
  await p.settle();
  assert.equal(covers(article).length, 0); assert.equal(article.style.position, '');
});

test('moving a classified tweet passage relocates its cover instead of covering the old article', async t => {
  const p = await page(tweet('first', 'Travel deal') + '<article id="second"><img src="https://example.com/b.jpg"></article>'); t.after(p.close);
  const first = p.doc.getElementById('first'), second = p.doc.getElementById('second');
  second.append(first.querySelector('[data-testid="tweetText"]')); await p.settle();
  assert.equal(covers(first).length, 0); assert.equal(covers(second).length, 1);
  assert.equal(first.style.position, '');
});

test('threshold changes, reveal-all, and disabling the site remove tweet covers', async t => {
  const p = await page(tweet('target', 'Travel deal')); t.after(p.close);
  const article = p.doc.getElementById('target');
  p.config.threshold = .99; await p.send('CONFIG_CHANGED'); await p.settle();
  assert.equal(covers(article).length, 0);
  p.config.threshold = .85; await p.send('CONFIG_CHANGED'); await p.settle();
  assert.equal(covers(article).length, 1);
  await p.send('REVEAL_ALL'); await p.settle(); assert.equal(covers(article).length, 0);
  await p.send('RESCAN'); await p.settle(); assert.equal(covers(article).length, 1);
  p.config.enabled = false; await p.send('CONFIG_CHANGED'); await p.settle();
  assert.equal(covers(article).length, 0); assert.equal(article.style.position, '');
});

test('generic article paragraphs keep passage-sized covers and do not cover unrelated images', async t => {
  const p = await page('<article id="generic"><p>A long travel story about the next vacation.</p><img src="https://example.com/c.jpg"></article>'); t.after(p.close);
  const article = p.doc.getElementById('generic');
  assert.equal(covers(article).length, 1); assert.equal(covers(article)[0].parentElement.tagName, 'P');
  assert.equal(article.style.position, '');
});
