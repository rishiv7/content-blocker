import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../extension/short-form.js', import.meta.url), 'utf8');
const STYLE_ID = 'short-form-suppression';

// A jsdom page runs the actual content script: real selectors, real history,
// real videos. Config, messaging, and pause() are the only mocked pieces.
// jsdom's window timers can lag well past 0ms, so every async effect is
// awaited through waitFor(predicate), never a fixed sleep.
const waitFor = async (predicate, timeout = 2000, step = 10) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor: condition not met within ' + timeout + 'ms');
    await new Promise(resolve => setTimeout(resolve, step));
  }
};

async function engine({url, config = {enabled: true, shortForm: true}, body = ''} = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {url, runScripts: 'outside-only'});
  const {window} = dom;
  const document = window.document;
  const state = {requests: [], warns: [], config: {...config}, popstate: 0, observers: {created: 0, disconnected: 0}};
  let listener = null;
  const RealObserver = window.MutationObserver;
  window.MutationObserver = class extends RealObserver {
    constructor(callback) { super(callback); state.observers.created++; }
    disconnect() { state.observers.disconnected++; return super.disconnect(); }
  };
  const nativeAdd = window.addEventListener.bind(window);
  window.addEventListener = (type, fn, options) => {
    if (type === 'popstate') state.popstate++;
    return nativeAdd(type, fn, options);
  };
  const pausedByEngine = new WeakSet();
  window.HTMLMediaElement.prototype.pause = function () { pausedByEngine.add(this); };
  window.chrome = {
    runtime: {
      onMessage: {addListener: fn => { listener = fn; }},
      sendMessage: async message => {
        state.requests.push(message);
        if (message.type === 'CONFIG') return {...state.config};
        throw new Error('Unexpected message');
      },
    },
  };
  window.console.warn = (...args) => state.warns.push(args.join(' '));
  const originalPush = window.history.pushState, originalReplace = window.history.replaceState;
  window.eval(source);
  await waitFor(() => state.requests.length > 0);
  await new Promise(resolve => setTimeout(resolve, 0)); // let sync() finish after the config round trip
  return {
    dom, window, document, requests: state.requests, pausedByEngine, warns: state.warns,
    originalPush, originalReplace, waitFor,
    // Live alias: fetchConfig replaces state.config on every round trip.
    get config() { return state.config; },
    send: message => new Promise(resolve => listener(message, {}, resolve)),
    css: () => document.getElementById(STYLE_ID)?.textContent || '',
    hasStyle: () => !!document.getElementById(STYLE_ID),
    flags: () => ({page: document.documentElement.getAttribute('data-sf-page'),
      items: document.documentElement.getAttribute('data-sf-items')}),
    popstateListeners: () => state.popstate,
    observer: () => state.observers,
    videos: () => [...document.querySelectorAll('video')],
    stopped: video => pausedByEngine.has(video) && !video.hasAttribute('autoplay'),
  };
}

test('criterion 1: hard /shorts/ load hides the media region, stops the video, and leaves chrome alone', async t => {
  const h = await engine({
    url: 'https://www.youtube.com/shorts/abc123',
    body: '<ytd-masthead id="masthead"></ytd-masthead><div id="guide"></div>' +
      '<ytd-player><video autoplay></video></ytd-player><div id="player"><video autoplay></video></div>',
  });
  assert.deepEqual(h.flags(), {page: 'youtube', items: 'youtube'});
  assert.ok(h.hasStyle());
  assert.match(h.css(), /html\[data-sf-page="youtube"\] ytd-player, #player, ytd-short-player, ytd-reel-video-renderer, ytd-shorts \{ display: none !important; \}/);
  assert.match(h.css(), /body::after \{ content: 'Short-form video blocked'/);
  await h.waitFor(() => h.videos().every(v => h.stopped(v)));
  const css = h.css();
  assert.ok(!css.includes('ytd-masthead') && !css.includes('#guide'), 'site chrome is never matched');
});

test('the bare /shorts/ feed route is page mode too', async t => {
  const h = await engine({
    url: 'https://www.youtube.com/shorts/',
    body: '<ytd-reel-video-renderer><video autoplay></video></ytd-reel-video-renderer>',
  });
  assert.equal(h.flags().page, 'youtube', 'the feed route engages page mode');
  await h.waitFor(() => h.stopped(h.document.querySelector('video')));
});

test('criterion 2: all three YouTube shelf candidates suppress, and an ordinary feed item stays visible', async t => {
  const h = await engine({
    url: 'https://www.youtube.com/',
    body: '<ytd-rich-shelf-renderer><video autoplay></video></ytd-rich-shelf-renderer>' +
      '<ytd-reel-shelf-renderer><video autoplay></video></ytd-reel-shelf-renderer>' +
      '<div class="shortsLockupViewModelHost"><video autoplay></video></div>' +
      '<ytd-rich-item-renderer><a href="/shorts/xyz"></a><video autoplay></video></ytd-rich-item-renderer>' +
      '<ytd-rich-item-renderer id="ordinary"><a href="/watch?v=1"></a><video autoplay></video></ytd-rich-item-renderer>',
  });
  assert.equal(h.flags().page, null, 'the home route is not page mode');
  const css = h.css();
  for (const selector of ['ytd-rich-shelf-renderer', 'ytd-reel-shelf-renderer', '.shortsLockupViewModelHost']) {
    assert.ok(css.includes(`html[data-sf-items="youtube"] ${selector}`), `candidate present: ${selector}`);
  }
  assert.ok(css.includes('ytd-rich-item-renderer:has(a[href*="/shorts/"])'), 'in-feed items anchor on href');
  const videos = h.videos();
  await h.waitFor(() => videos.slice(0, 4).every(v => h.stopped(v)));
  assert.ok(!h.pausedByEngine.has(videos[4]) && videos[4].hasAttribute('autoplay'),
    'an item whose link is /watch is untouched');
});

test('criterion 3: SPA transitions engage and disengage without reload, and teardown restores history', async t => {
  const h = await engine({url: 'https://www.youtube.com/watch?v=abc'});
  assert.equal(h.flags().page, null);
  assert.notEqual(h.window.history.pushState, h.originalPush, 'history is patched while active');
  assert.equal(h.popstateListeners(), 1, 'a popstate listener is registered while active');
  h.window.history.pushState({}, '', '/shorts/abc');
  assert.equal(h.flags().page, 'youtube', 'engaged without a reload');
  h.window.history.pushState({}, '', '/watch?v=abc');
  assert.equal(h.flags().page, null, 'disengaged without a reload');
  h.window.history.replaceState({}, '', '/shorts/xyz');
  assert.equal(h.flags().page, 'youtube', 'replaceState re-derives the page mode too');
  // A traversal delivers popstate after the location changed; jsdom does not
  // implement traversal, so change it natively (bypassing our wrapper) and
  // dispatch the event the browser would deliver.
  h.originalPush.call(h.window.history, {}, '', '/watch?v=abc');
  assert.equal(h.flags().page, 'youtube', 'a location change alone does not re-derive');
  h.window.dispatchEvent(new h.window.Event('popstate'));
  assert.equal(h.flags().page, null, 'popstate re-derives the page mode');
  h.config.shortForm = false;
  await h.send({type: 'CONFIG_CHANGED'});
  await h.waitFor(() => !h.hasStyle());
  assert.deepEqual(h.flags(), {page: null, items: null});
  assert.equal(h.window.history.pushState, h.originalPush, 'native history restored on teardown');
  assert.equal(h.window.history.replaceState, h.originalReplace);
  assert.ok(h.observer().disconnected >= 1, 'the observer stops');
  h.config.shortForm = true;
  await h.send({type: 'CONFIG_CHANGED'});
  // Re-engage lands on /watch?v=abc, so item mode comes back but the page
  // attribute stays unset — only a short-form path re-arms page mode.
  await h.waitFor(() => h.flags().items === 'youtube' && h.hasStyle());
});

test('criterion 4: Instagram and Facebook items suppress via href-anchored containers', async t => {
  const ig = await engine({
    url: 'https://www.instagram.com/',
    body: '<div role="article"><a href="/reels/reel123/"></a><video autoplay></video></div>' +
      '<div role="article" id="photo"><a href="/p/abc/"></a><video autoplay></video></div>',
  });
  assert.ok(ig.css().includes('[role="article"]:has(a[href*="/reels"])'));
  const [igReel, igPhoto] = ig.document.querySelectorAll('video');
  await ig.waitFor(() => ig.stopped(igReel));
  assert.ok(!ig.pausedByEngine.has(igPhoto) && igPhoto.hasAttribute('autoplay'), 'ordinary posts stay visible');
  const reelsPage = await engine({url: 'https://www.instagram.com/reels/abc/', body: '<video autoplay></video>'});
  assert.equal(reelsPage.flags().page, 'instagram', '/reels/<id> is page mode');
  await reelsPage.waitFor(() => reelsPage.stopped(reelsPage.document.querySelector('video')), 2000);
  const fb = await engine({
    url: 'https://www.facebook.com/',
    body: '<div role="article"><a href="/reel/998877"></a><video autoplay></video></div>',
  });
  assert.ok(fb.css().includes('[role="article"]:has(a[href*="/reel/"])'));
  await fb.waitFor(() => fb.stopped(fb.document.querySelector('video')));
  const fbPage = await engine({url: 'https://www.facebook.com/reel/998877', body: ''});
  assert.equal(fbPage.flags().page, 'facebook', '/reel/<id> is page mode');
});

test('criterion 5: TikTok home is page mode with videos stopped; item mode still works off-home', async t => {
  const home = await engine({
    url: 'https://www.tiktok.com/',
    body: '<div data-e2e="recommend-list-item"><a href="/@user/video/123"></a><video autoplay></video></div>',
  });
  assert.equal(home.flags().page, 'tiktok');
  await home.waitFor(() => home.stopped(home.document.querySelector('video')));
  assert.ok(home.css().includes('[data-e2e="recommend-list-item"]:has(a[href*="/video/"])'));
  const profile = await engine({url: 'https://www.tiktok.com/@user/video/123', body: '<video autoplay></video>'});
  assert.equal(profile.flags().page, null, 'a profile video page is not the home feed route');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(!profile.pausedByEngine.has(profile.document.querySelector('video')),
    'item mode does not touch videos outside matched items');
});

test('criterion 6: mode off, site disabled, and unknown hosts leave zero side effects', async t => {
  const off = await engine({
    url: 'https://www.youtube.com/shorts/abc',
    config: {enabled: true, shortForm: false},
    body: '<ytd-player><video autoplay></video></ytd-player>',
  });
  assert.equal(off.hasStyle(), false, 'no injected style element');
  assert.deepEqual(off.flags(), {page: null, items: null});
  assert.equal(off.window.history.pushState, off.originalPush, 'history untouched');
  assert.equal(off.popstateListeners(), 0, 'no popstate listener registered');
  assert.equal(off.observer().created, 0, 'no observer created');
  const video = off.document.querySelector('video');
  assert.ok(!off.pausedByEngine.has(video) && video.hasAttribute('autoplay'), 'playback untouched');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(off.hasStyle(), false, 'still nothing after a drain');
  assert.deepEqual(off.warns, [], 'no console noise');
  const disabled = await engine({url: 'https://www.youtube.com/', config: {enabled: false, shortForm: true}});
  assert.equal(disabled.hasStyle(), false);
  assert.deepEqual(disabled.flags(), {page: null, items: null});
  assert.equal(disabled.window.history.pushState, disabled.originalPush);
  assert.equal(disabled.popstateListeners(), 0);
  const elsewhere = await engine({url: 'https://example.com/', config: {enabled: true, shortForm: true}});
  assert.equal(elsewhere.hasStyle(), false, 'an unlisted host stays inert');
  assert.equal(elsewhere.window.history.pushState, elsewhere.originalPush);
  assert.equal(elsewhere.popstateListeners(), 0);
});

test('newly inserted matched items are swept, and programmatic playback is re-paused', async t => {
  const h = await engine({url: 'https://www.youtube.com/'});
  const shelf = h.document.createElement('ytd-rich-shelf-renderer');
  const video = h.document.createElement('video');
  video.setAttribute('autoplay', '');
  shelf.appendChild(video);
  h.document.body.appendChild(shelf);
  await h.waitFor(() => h.stopped(video));
  h.window.HTMLMediaElement.prototype.pause = function () {};
  video.dispatchEvent(new h.window.Event('play'));
  assert.ok(h.pausedByEngine.has(video), 'a play event re-pauses inside a matched region');
  const home = await engine({url: 'https://www.youtube.com/watch?v=1', body: '<video></video>'});
  const free = home.document.querySelector('video');
  free.dispatchEvent(new h.window.Event('play'));
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(!home.pausedByEngine.has(free), 'playback outside matched regions is free');
});

test('every generated rule is scoped to the engine attributes and never targets bare chrome', async t => {
  const h = await engine({url: 'https://www.youtube.com/'});
  const rules = h.css().split('\n').filter(line => line.includes('{'));
  assert.ok(rules.length > 10, 'all four surfaces generated rules');
  // A bare chrome tag selector (element itself, not a pseudo-element or an
  // attribute-scoped prefix like html[data-sf-…]).
  const bare = /^(html|body|main|nav|header|footer|aside)(?![\w[:\]-])/;
  for (const rule of rules) {
    assert.ok(rule.startsWith('html[data-sf-'), `rule not attribute-scoped: ${rule}`);
    for (const part of rule.slice(0, rule.indexOf('{')).split(',')) {
      assert.ok(!bare.test(part.trim()), 'body itself is never hidden (only body::after chips)');
    }
  }
});

test('a router that bypasses the history patch still re-derives via mutations', async t => {
  const h = await engine({url: 'https://www.youtube.com/watch?v=abc'});
  assert.equal(h.flags().page, null);
  // A router holding its own native reference skips our wrapper: the URL and
  // the DOM change without onNavigate ever running (live YouTube behavior).
  h.originalPush.call(h.window.history, {}, '', '/shorts/abc');
  const slide = h.document.createElement('ytd-reel-video-renderer');
  h.document.body.appendChild(slide); // the navigation's DOM swap
  await h.waitFor(() => h.flags().page === 'youtube', 2000, 20);
  h.originalPush.call(h.window.history, {}, '', '/watch?v=abc');
  h.document.body.removeChild(slide);
  await h.waitFor(() => h.flags().page === null, 2000, 20);
});

test('re-injection is idempotent', async t => {
  const h = await engine({url: 'https://www.youtube.com/'});
  h.window.eval(source);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(h.requests.length, 1, 'the second copy never runs');
});

test('criterion 9: the manifest gains only the short-form registration and zero permissions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['https://*.youtube.com/*', 'https://*.tiktok.com/*', 'https://*.instagram.com/*', 'https://*.facebook.com/*'],
    js: ['short-form.js'],
    run_at: 'document_start',
  }]);
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'scripting']);
  assert.deepEqual(manifest.host_permissions, ['https://api.typesafe.ai/*', 'https://api.openai.com/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.ok(!JSON.stringify(manifest).includes('declarativeNetRequest'));
});
