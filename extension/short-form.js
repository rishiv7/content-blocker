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
      // Verified 2026-09-24: on /shorts/<id> both <video> elements sit inside
      // ytd-player / #player regions; masthead and guide sit outside them.
      pagePath: /^\/shorts\/[^/?]+/,
      pageHide: 'ytd-player, #player, ytd-short-player',
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
        `html[${PAGE_ATTR}="${surface.id}"] body::after { content: 'Short-form video blocked'; position: fixed !important; top: 12px !important; left: 50% !important; transform: translateX(-50%) !important; z-index: 2147483647 !important; padding: 4px 14px !important; border-radius: 999px !important; background: #eef0e9 !important; color: #5c6353 !important; font: 500 12px/1.4 system-ui, sans-serif !important; box-shadow: 0 1px 4px rgb(0 0 0 / 18%) !important; pointer-events: none !important; }`);
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

  function sync() {
    state.surface = surfaceFor(location.hostname);
    if (!isActive()) { teardown(); return; }
    ensureStylesheet();
    document.documentElement.setAttribute(ITEMS_ATTR, state.surface.id);
    recomputePage();
  }

  function teardown() {
    state.surface = null;
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
