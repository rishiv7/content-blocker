// Deterministic short-form video suppression (YouTube Shorts, TikTok, Instagram
// and Facebook Reels). Registered at document_start on every surface host, but
// stays fully inert unless CONFIG reports the site enabled AND the global
// short-form mode on. No network, no classifier, no API key: everything here is
// DOM/URL logic. The text pipeline in content.js is untouched and independent.
(() => {
  if (globalThis.__shortFormBlocking) return;
  globalThis.__shortFormBlocking = true;

  const STYLE_ID = 'short-form-suppression';
  const PAGE_ATTR = 'data-sf-page';   // set while the URL path itself is short-form
  const ITEMS_ATTR = 'data-sf-items'; // set while feed items are suppressed on this surface

  // The only place site knowledge lives. Every selector row is dated; when a
  // surface ships new markup the fix is a new row here, never page logic.
  // verified = matched against the live site on the date shown; unverified =
  // prior-art candidate that could not be confirmed (login/bot wall or a
  // non-hydrating feed in the verification sandbox) and is expected to fail
  // visible — content shows normally — until re-checked.
  const SURFACES = [
    {
      id: 'youtube',
      host: /(^|\.)youtube\.com$/,
      // Verified 2026-09-24: on /shorts/<id> the visible slide is
      // ytd-reel-video-renderer, which wraps the (inner) ytd-player/#player
      // hosts; ytd-shorts is the whole Shorts view root (slide, metadata,
      // swipe peek and stage backdrop) and exists only on Shorts routes, so
      // page mode hides it outright. Masthead and guide sit outside it.
      // /shorts/ without an id is the Shorts feed route — the same surface,
      // so page mode covers it too.
      pagePath: /^\/shorts(\/|$)/,
      pageHide: 'ytd-player, #player, ytd-short-player, ytd-reel-video-renderer, ytd-shorts',
      items: [
        // Verified 2026-09-24 on search results: lockups are the present-day
        // markup and link relatively (/shorts/<id>).
        {container: '.shortsLockupViewModelHost'},
        // Verified 2026-09-24: today's search shelf container; href-anchored
        // so shelves of ordinary videos stay visible.
        {container: 'grid-shelf-view-model', hrefSelector: 'a[href*="/shorts/"]'},
        // Unverified 2026-09-24 (home feed did not hydrate in the sandbox):
        // prior-art candidates for the home Shorts shelf.
        {container: 'ytd-rich-shelf-renderer'},
        {container: 'ytd-reel-shelf-renderer'},
        // Unverified 2026-09-24: home-feed items whose link points at a Short.
        {container: 'ytd-rich-item-renderer', hrefSelector: 'a[href*="/shorts/"]'},
      ],
    },
    {
      id: 'tiktok',
      host: /(^|\.)tiktok\.com$/,
      pagePath: /^\/$/, // the web app's home IS the feed
      // Unverified 2026-09-24: the sandbox hit a login/bot wall and no feed
      // rendered. Prior-art selectors; a miss fails visible.
      pageHide: '[data-e2e="recommend-list"]',
      items: [
        {container: '[data-e2e="recommend-list-item"]', hrefSelector: 'a[href*="/video/"]'},
      ],
    },
    {
      id: 'instagram',
      host: /(^|\.)instagram\.com$/,
      pagePath: /^\/reels?(\/|$)/,
      // Unverified 2026-09-24: /reels/ renders a blank login wall in the
      // sandbox. Feed posts are role=article; href anchoring keeps ordinary
      // posts visible.
      items: [
        {container: '[role="article"]', hrefSelector: 'a[href*="/reels"]'},
      ],
    },
    {
      id: 'facebook',
      host: /(^|\.)facebook\.com$/,
      pagePath: /^\/reel\/[^/?]+/,
      // Unverified 2026-09-24: /reel/ redirects to login.php in the sandbox.
      items: [
        {container: '[role="article"]', hrefSelector: 'a[href*="/reel/"]'},
      ],
    },
  ];

  const state = {config: {enabled: false, shortForm: false}, surface: null};
  const surfaceFor = host => SURFACES.find(s => s.host.test(host)) || null;
  const isActive = () => !!state.surface && state.config.enabled && state.config.shortForm;

  // One persistent stylesheet keyed off documentElement attributes, so removing
  // the attributes (or the element) makes every rule stop matching at once.
  function stylesheet() {
    const rules = [];
    for (const surface of SURFACES) {
      if (surface.pageHide) rules.push(
        // Page mode: the route itself is short-form. Hide the media region;
        // header, navigation and other chrome are never matched.
        `html[${PAGE_ATTR}="${surface.id}"] ${surface.pageHide} { display: none !important; }`,
        // Inert placeholder chip; there is no reveal affordance for video.
        `html[${PAGE_ATTR}="${surface.id}"] body::after { content: 'Short-form video blocked'; position: fixed !important; bottom: 24px !important; left: 50% !important; transform: translateX(-50%) !important; z-index: 2147483647 !important; padding: 4px 14px !important; border-radius: 999px !important; background: #eef0e9 !important; color: #5c6353 !important; font: 500 12px/1.4 system-ui, sans-serif !important; box-shadow: 0 1px 4px rgb(0 0 0 / 18%) !important; pointer-events: none !important; }`);
      // Item mode: in-feed elements linking to short-form collapse to a small
      // inert chip. Anchoring prefers the item's own link href over volatile
      // class names; class-only rows are last-resort shelf candidates.
      for (const item of surface.items) {
        const anchor = item.hrefSelector ? `${item.container}:has(${item.hrefSelector})` : item.container;
        const scope = `html[${ITEMS_ATTR}="${surface.id}"]`;
        rules.push(
          `${scope} ${anchor} > * { display: none !important; }`,
          `${scope} ${anchor} { visibility: hidden !important; position: relative !important; box-sizing: border-box !important; height: 24px !important; min-height: 0 !important; max-height: 24px !important; overflow: hidden !important; border-radius: 8px !important; background: #eef0e9 !important; }`,
          `${scope} ${anchor}::after { content: 'Blocked short-form video'; visibility: visible !important; position: absolute !important; inset: 0 !important; z-index: 2147483647 !important; font: 500 10px/24px system-ui, sans-serif !important; color: #5c6353 !important; text-align: center !important; letter-spacing: .02em !important; pointer-events: none !important; }`);
      }
    }
    return rules.join('\n');
  }

  function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = stylesheet();
    // document_start: head may not exist yet; the root always does.
    document.documentElement.appendChild(style);
  }

  function recomputePage() {
    const root = document.documentElement;
    if (state.surface.pagePath?.test(location.pathname)) root.setAttribute(PAGE_ATTR, state.surface.id);
    else root.removeAttribute(PAGE_ATTR);
  }

  // ---- Media stop ----
  // Matched regions get every <video> paused and autoplay stripped. Sites can
  // also start playback programmatically, so a capture-phase play listener
  // re-pauses between sweeps; the MutationObserver's only job is scheduling
  // the sweep — CSS already covers newly inserted feed items.
  let handled = new WeakSet(), sweepTimer = null, observer = null;

  function matchedItemRoot(video) {
    for (const item of state.surface.items) {
      const root = video.closest(item.container);
      if (root && (!item.hrefSelector || root.querySelector(item.hrefSelector))) return root;
    }
    return null;
  }

  // Page mode: the route itself is short-form, so every video on it belongs to
  // the suppressed surface. Item mode: only videos inside a matched item.
  function suppressible(video) {
    return document.documentElement.getAttribute(PAGE_ATTR) === state.surface.id || !!matchedItemRoot(video);
  }

  function stop(video) {
    handled.add(video);
    video.pause();
    video.removeAttribute('autoplay');
  }

  function sweep() {
    if (!isActive()) return;
    for (const video of document.querySelectorAll('video')) {
      if (!handled.has(video) && suppressible(video)) stop(video);
    }
  }

  function scheduleSweep() {
    // Coalesce insertion storms into one sweep per burst without resetting
    // the timer on every mutation.
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => { sweepTimer = null; sweep(); }, 0);
  }

  function onPlay(event) {
    const video = event.target;
    if (!isActive() || video.tagName !== 'VIDEO' || !suppressible(video)) return;
    stop(video);
  }

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleSweep);
    // document_start: documentElement exists even when body does not yet.
    observer.observe(document.documentElement, {subtree: true, childList: true});
    document.addEventListener('play', onPlay, true);
  }

  // ---- SPA navigation ----
  // In-feed transitions are pushState/replaceState navigations that never
  // reload the document; re-derive the page mode on every one. The patch
  // exists only while suppression is active and is restored on teardown, so
  // the mode-off behavior stays byte-for-byte today's.
  const nativeHistory = {pushState: history.pushState, replaceState: history.replaceState};
  let historyPatched = false;

  function onNavigate() {
    if (!isActive()) return;
    recomputePage();
    scheduleSweep();
  }

  const wrappedPush = function (...args) {
    const result = nativeHistory.pushState.apply(history, args);
    onNavigate();
    return result;
  };
  const wrappedReplace = function (...args) {
    const result = nativeHistory.replaceState.apply(history, args);
    onNavigate();
    return result;
  };

  function patchHistory() {
    if (historyPatched) return;
    historyPatched = true;
    history.pushState = wrappedPush;
    history.replaceState = wrappedReplace;
    addEventListener('popstate', onNavigate);
  }

  function unpatchHistory() {
    if (!historyPatched) return;
    // A later wrapper layered on top of ours is not ours to remove.
    if (history.pushState === wrappedPush) history.pushState = nativeHistory.pushState;
    if (history.replaceState === wrappedReplace) history.replaceState = nativeHistory.replaceState;
    removeEventListener('popstate', onNavigate);
    historyPatched = false;
  }

  function sync() {
    state.surface = surfaceFor(location.hostname);
    if (!isActive()) { teardown(); return; }
    ensureStylesheet();
    document.documentElement.setAttribute(ITEMS_ATTR, state.surface.id);
    recomputePage();
    ensureObserver();
    patchHistory();
    scheduleSweep();
  }

  function teardown() {
    state.surface = null;
    observer?.disconnect();
    observer = null;
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    document.removeEventListener('play', onPlay, true);
    unpatchHistory();
    handled = new WeakSet();
    const root = document.documentElement;
    root.removeAttribute(PAGE_ATTR);
    root.removeAttribute(ITEMS_ATTR);
    document.getElementById(STYLE_ID)?.remove();
  }

  async function fetchConfig() {
    try {
      const next = await chrome.runtime.sendMessage({type: 'CONFIG'});
      if (!next || next.error) throw new Error(next?.error || 'No config returned');
      state.config = {enabled: !!next.enabled, shortForm: !!next.shortForm};
      sync();
    } catch (error) {
      // The worker is unreachable (an extension update/reload orphaned this
      // script). Stay fully inert — fail visible — until CONFIG_CHANGED.
      console.warn('[short-form] staying inert:', error.message);
    }
  }

  chrome.runtime.onMessage.addListener((m, _sender, respond) => {
    if (m?.type === 'CONFIG_CHANGED') { fetchConfig(); respond({ok: true}); }
  });
  fetchConfig();
})();
