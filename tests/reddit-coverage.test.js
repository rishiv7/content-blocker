import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {collectRoots} from '../extension/adaptors/roots.js';
import {redditAdaptor} from '../extension/adaptors/reddit.js';

const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

const taglineText = 'submitted 12 hours ago by Apart_Lawfulness3258 to r/PeterExplainsTheJoke';

// Old-UI post fixture mirroring the pinned logged-out old.reddit.com markup
// (archived 2026-08-31 front page): div.thing > a.thumbnail > img plus
// div.entry > div.top-matter > p.title (a.title + flair + domain span) and
// p.tagline, with optional .md selftext and expando media.
const oldPost = ({id, title, selftext = null, media = null}) => {
  const thumb = media ? '<a class="thumbnail invisible-when-pinned may-blank outbound" href="https://i.redd.it/x.jpg"><img src="https://i.redd.it/x.jpg" width="70" height="70" alt=""></a>' : '';
  const expando = media === 'expanded' ? '<div class="expando"><img class="preview" src="https://i.redd.it/x.jpg" alt=""></div>' : '';
  const expandoButton = media === 'collapsed' ? '<div class="expando-button collapsed hide-when-pinned video"></div>' : '';
  const body = selftext ? `<div class="md"><div>${selftext}</div></div>` : '';
  return `<div class=" thing id-t3_${id} link " id="post-${id}">
    ${thumb}
    <div class="entry unvoted"><div class="top-matter">
      <p class="title"><a class="title may-blank outbound" href="https://i.redd.it/x.jpg" data-event-action="title">${title}</a><span class="flairrichtext linkflairlabel"><span>Meme needing explanation</span></span><span class="domain">(<a href="https://i.redd.it/">i.redd.it</a>)</span></p>
      <p class="tagline">${taglineText}</p>
      ${expandoButton}${expando}${body}
    </div></div>
  </div>`;
};

// shreddit detail fixture mirroring the pinned archived post page (2025-01):
// shreddit-post with an h1[slot="title"] and a [slot="post-media-container"],
// plus shreddit-comment bodies as div[slot="comment"] wrapping paragraphs.
const shredditDetail = `
  <shreddit-post id="p1" post-type="image" post-title="peter?">
    <h1 id="post-title-t3_p1" slot="title">peter?</h1>
    <div slot="post-media-container"><shreddit-aspect-ratio><img src="https://i.redd.it/x.jpg" alt=""></shreddit-aspect-ratio></div>
  </shreddit-post>
  <shreddit-comment-tree thingid="c0">
    <shreddit-comment thingid="t1_a" content-type="text" arialabel="Comment from someone">
      <div slot="content">
        <div class="md text-14" id="t1_a-comment-rtjson-content" slot="comment">
          <div id="-post-rtjson-content">
            <p>Is that the frontal lobe? What else did he loose after the accident and the surgery?</p>
            <p>And did the other regions compensate for the loss over time afterwards?</p>
          </div>
        </div>
      </div>
    </shreddit-comment>
  </shreddit-comment-tree>`;

// A jsdom page drives the real content script with a reddit hostname, so the
// fixture resolves the reddit adaptor exactly as the browser would. The
// optional setup callback attaches shadow roots before the script's first
// scan; unlisted passages score .95 (flagged) through the cache stub.
async function page(html, values = {}, {url = 'https://old.reddit.com/', setup} = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {url, runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window, roots = new WeakMap();
  let listener;
  const config = {enabled: true, configured: true, threshold: .85, limit: 120, filterId: 'rule1'};
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {get() {return this.textContent;}});
  w.HTMLElement.prototype.getBoundingClientRect = () => ({width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300});
  const style = w.getComputedStyle.bind(w);
  w.getComputedStyle = node => {const result = style(node); if (!result.position) result.position = 'static'; return result;};
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function(options) {const root = attach.call(this, options); roots.set(this, root); return root;};
  w.chrome = {runtime: {
    sendMessage: async message => {
      if (message.type === 'CONFIG') return {...config};
      if (message.type === 'CACHE_LOOKUP') return {scores: message.texts.map(text => values[text] ?? .95)};
      if (message.type === 'DETECT') return {score: .95, source: 'api'};
      throw new Error('Unexpected message');
    },
    onMessage: {addListener(fn) {listener = fn;}}
  }};
  if (setup) setup(w.document, w);
  w.eval(script);
  const settle = async () => {for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));};
  const send = type => new Promise(resolve => listener({type}, {}, resolve));
  await settle();
  return {w, doc: w.document, settle, send, close: () => w.close()};
}
const covers = node => node.querySelectorAll('[data-slop-shield="cover"]');

test('old-UI link-post titles are candidates and the cover overlays the title link', async t => {
  const p = await page(oldPost({id: 'txt', title: 'peter?', selftext: '<p>A long selftext passage about the history of the municipal library and its reading rooms.</p>'}), {
    [taglineText]: 0,
    'A long selftext passage about the history of the municipal library and its reading rooms.': 0
  });
  t.after(p.close);
  const post = p.doc.getElementById('post-txt');
  // The short title ("peter?") is discovered: titles are not held to the
  // generic 20-character minimum, the way short tweets are not.
  assert.equal(covers(post).length, 1);
  const host = covers(post)[0];
  assert.equal(host.parentElement.matches('a.title'), true, 'the cover sits on the title link');
  // The cover overlays the title text only: flair and domain stay outside it.
  assert.equal(host.parentElement.contains(p.doc.querySelector('.flairrichtext')), false);
  assert.equal(host.parentElement.contains(p.doc.querySelector('.domain')), false);
  assert.equal(covers(p.doc.querySelector('.tagline')).length, 0);
});

test('old-UI media-only posts flag as the media container, not the title line', async t => {
  // Collapsed expando (the logged-out shape): the thumbnail is the media
  // container present in the DOM.
  const collapsed = await page(oldPost({id: 'img', title: 'peter?', media: 'collapsed'}), {[taglineText]: 0});
  t.after(collapsed.close);
  const imgPost = collapsed.doc.getElementById('post-img');
  assert.equal(covers(imgPost).length, 1);
  assert.equal(covers(imgPost)[0].parentElement.matches('a.thumbnail'), true, 'the cover overlays the thumbnail');
  assert.equal(covers(imgPost)[0].parentElement.matches('a.title'), false);

  // Expanded expando: the cover moves up to the expando media container.
  const expanded = await page(oldPost({id: 'vid', title: 'peter?', media: 'expanded'}), {[taglineText]: 0});
  t.after(expanded.close);
  const vidPost = expanded.doc.getElementById('post-vid');
  assert.equal(covers(vidPost).length, 1);
  assert.equal(covers(vidPost)[0].parentElement.className, 'expando', 'the cover overlays the expanded media');
});

test('a media-bearing post with selftext still flags its title as the title link', async t => {
  const p = await page(oldPost({id: 'mix', title: 'peter?', selftext: '<p>A long selftext passage about the history of the municipal library and its reading rooms.</p>', media: 'collapsed'}), {
    [taglineText]: 0,
    'A long selftext passage about the history of the municipal library and its reading rooms.': 0
  });
  t.after(p.close);
  const post = p.doc.getElementById('post-mix');
  assert.equal(covers(post).length, 1);
  assert.equal(covers(post)[0].parentElement.matches('a.title'), true, 'selftext keeps the cover on the title link');
});

test('media-bearing selftext stays a candidate under the reddit media policy', async t => {
  const p = await page(oldPost({id: 'gal', title: 'peter?', selftext: '<p>A long selftext passage about the history of the municipal library.<img src="https://i.redd.it/inline.jpg" alt=""></p>'}), {[taglineText]: 0});
  t.after(p.close);
  // The shipped media policy dropped any candidate holding an image; the
  // reddit adaptor keeps prose-with-media scoreable.
  const para = p.doc.querySelector('.md p');
  assert.equal(covers(para).length, 1, 'the prose paragraph with its inline image is discovered and covered');
});

test('shreddit detail surfaces: the h1 title and one candidate per comment body', async t => {
  const p = await page(shredditDetail, {}, {url: 'https://www.reddit.com/'});
  t.after(p.close);
  const title = p.doc.querySelector('h1[slot="title"]');
  assert.equal(covers(title).length, 1, 'the short detail title is discovered and covered');
  const commentBody = p.doc.querySelector('div[slot="comment"]');
  assert.equal(covers(commentBody).length, 1, 'the comment body is discovered');
  assert.equal(covers(commentBody)[0].parentElement, commentBody, 'the cover sits on the comment body container');
  // Both paragraphs collapse into the one comment-body candidate: no
  // per-paragraph covers inside the comment.
  assert.equal(covers(p.doc.querySelector('shreddit-comment')).length, 1);
  assert.ok([...commentBody.querySelectorAll('p')].every(p => covers(p).length === 0));
});

test('shreddit candidates inside open shadow roots are discovered; closed roots stay silent', async t => {
  let openBody;
  const light = 'A long light-dom passage about the municipal library reading rooms.';
  const open = 'A long shreddit passage discovered inside an open shadow root today.';
  const closed = 'A long shreddit passage hidden inside a closed shadow root forever.';
  const p = await page(`<p>${light}</p><div id="open-host"></div><div id="closed-host"></div>`, {
    [light]: 0
  }, {url: 'https://www.reddit.com/', setup: d => {
    const openHost = d.getElementById('open-host');
    const openRoot = openHost.attachShadow({mode: 'open'});
    openRoot.innerHTML = `<shreddit-comment thingid="t1_o"><div slot="comment"><p>${open}</p></div></shreddit-comment>`;
    openBody = openRoot.querySelector('div[slot="comment"]');
    const closedHost = d.getElementById('closed-host');
    const closedRoot = closedHost.attachShadow({mode: 'closed'});
    closedRoot.innerHTML = `<p>${closed}</p>`;
  }});
  t.after(p.close);
  assert.equal(covers(openBody).length, 1, 'the open shadow root candidate is discovered and covered');
  assert.equal(covers(p.doc.body).length, 0, 'closed-root content never surfaces');
  assert.equal((await p.send('STATUS')).error, '', 'closed roots are skipped silently');
  // A rescan re-collects the shadow roots without errors or duplicate work.
  await p.send('RESCAN'); await p.settle();
  assert.equal(covers(openBody).length, 1);
});

test('the reddit dialog exclusion stays shipped: a login modal is not a candidate surface', async t => {
  const p = await page(`
    <div role="dialog" aria-label="Log in">
      <p>A long login prompt passage about the municipal library reading rooms.</p>
      <form><input type="text"><button>Continue</button></form>
    </div>`);
  t.after(p.close);
  assert.equal(p.doc.querySelectorAll('[data-slop-shield="cover"]').length, 0);
});

test('the adaptor traversal copy behaves identically to the canonical collectRoots', () => {
  const dom = new JSDOM('<!doctype html><body></body>', {url: 'https://www.reddit.com/'});
  const d = dom.window.document;
  const host = d.createElement('shreddit-async-loader'); d.body.append(host);
  const openRoot = host.attachShadow({mode: 'open'});
  openRoot.innerHTML = '<p>open</p>';
  const nestedHost = d.createElement('div'); openRoot.append(nestedHost);
  const nestedRoot = nestedHost.attachShadow({mode: 'open'});
  nestedRoot.innerHTML = '<p>nested</p>';
  const closedHost = d.createElement('div'); d.body.append(closedHost);
  closedHost.attachShadow({mode: 'closed'}).innerHTML = '<p>closed</p>';
  assert.deepEqual([...redditAdaptor.roots(d)], [...collectRoots(d)]);
  dom.window.close();
});
