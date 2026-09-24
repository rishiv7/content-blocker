(() => {
  if (globalThis.__slopShield) return;
  globalThis.__slopShield = true;
  // SiteAdaptor seam. The canonical modules live in extension/adaptors/ (pure
  // ES modules); content.js is injected as a classic script, so it carries a
  // runtime mirror that tests/registry.test.js keeps honest with them.
  // Mirrors extension/adaptors/roots.js (canonical open-shadow traversal);
  // this classic script cannot import the ES module.
  const collectRoots = (root = document) => {
    const roots = [root];
    for (const host of root.querySelectorAll('*'))
      if (host.shadowRoot) roots.push(...collectRoots(host.shadowRoot));
    return roots;
  };
  const genericAdaptor = {
    id: 'generic',
    matches: () => true,
    candidates: 'p, li, blockquote, [data-testid="tweetText"], [data-ad-preview="message"], .md > div, div[dir="auto"]',
    // Neutral dialog policy: the blanket [role="dialog"] exclusion is dropped
    // — content dialogs (article lightboxes, comment modals) are candidate
    // surfaces. Interface chrome stays excluded structurally (forms,
    // textboxes, contenteditable), so login modals and cookie banners built
    // on those stay uncovered.
    exclude: 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [aria-hidden="true"], [hidden], [data-slop-shield]',
    // A flagged tweet covers its whole article, including attached images and
    // quoted content. Other page passages keep their individual text covers.
    targetOf: node => node.matches('[data-testid="tweetText"]') ? node.closest('article') || node : node,
    // Topic preferences can match short tweets; generic page fragments still
    // need enough text to avoid spending requests on tiny interface labels.
    minText: node => node.matches('[data-testid="tweetText"]') ? 1 : 20,
    // Shipped media policy: a candidate holding interactive or media
    // descendants is never scored on its own.
    eligible: node => !node.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"]), img, video, iframe'),
    container: '[data-testid="tweetText"]',
    // Universal-engine opt-in: discovery also scans every reachable OPEN
    // shadow root (closed roots are unreachable by design). Mirrors the
    // canonical traversal in extension/adaptors/roots.js above.
    roots: collectRoots
  };
  const xAdaptor = {
    id: 'x',
    matches: h => h === 'x.com' || h === 'twitter.com' || h.endsWith('.x.com') || h.endsWith('.twitter.com'),
    candidates: 'p, li, blockquote, [data-testid="tweetText"], [data-ad-preview="message"], .md > div, div[dir="auto"]',
    exclude: 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [aria-hidden="true"], [hidden], [data-slop-shield]',
    // A flagged tweet covers its whole article, including attached images and
    // quoted content. Other page passages keep their individual text covers.
    targetOf: node => node.matches('[data-testid="tweetText"]') ? node.closest('article') || node : node,
    // Topic preferences can match short tweets; generic page fragments still
    // need enough text to avoid spending requests on tiny interface labels.
    minText: node => node.matches('[data-testid="tweetText"]') ? 1 : 20,
    // Shipped media policy: a candidate holding interactive or media
    // descendants is never scored on its own.
    eligible: node => !node.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"]), img, video, iframe'),
    container: '[data-testid="tweetText"]'
  };
  const redditAdaptor = {
    id: 'reddit',
    matches: h => h === 'reddit.com' || h.endsWith('.reddit.com'),
    candidates: 'p, li, blockquote, [data-testid="tweetText"], [data-ad-preview="message"], .md > div, div[dir="auto"]',
    exclude: 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [aria-hidden="true"], [hidden], [data-slop-shield]',
    // A flagged tweet covers its whole article, including attached images and
    // quoted content. Other page passages keep their individual text covers.
    targetOf: node => node.matches('[data-testid="tweetText"]') ? node.closest('article') || node : node,
    // Topic preferences can match short tweets; generic page fragments still
    // need enough text to avoid spending requests on tiny interface labels.
    minText: node => node.matches('[data-testid="tweetText"]') ? 1 : 20,
    // Shipped media policy: a candidate holding interactive or media
    // descendants is never scored on its own.
    eligible: node => !node.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"]), img, video, iframe'),
    container: '[data-testid="tweetText"]'
  };
  // TODO: linkedin adaptor arrives with the LinkedIn PR; linkedin.com is
  // served by the generic adaptor until then.
  const SITE_ADAPTORS = [xAdaptor, redditAdaptor];
  const adaptorFor = hostname => {
    const host = (hostname || '').toLowerCase();
    return SITE_ADAPTORS.find(a => a.matches(host)) ?? genericAdaptor;
  };
  // A content script's hostname never changes, so the adaptor resolves once.
  const adaptor = adaptorFor(globalThis.location?.hostname ?? '');
  // Exposed for tests/registry.test.js to audit the mirror against the
  // canonical modules; harmless in the isolated content-script world.
  globalThis.__slopShieldAdaptors = {x: xAdaptor, reddit: redditAdaptor, generic: genericAdaptor, adaptorFor};
  const MAX = 10000;
  let config = {enabled: false, configured: false, threshold: .85, limit: 120, filterId: null};
  let epoch = 0, configRequest = 0, busy = false, lookupBusy = false, error = '', timer, observer, paused = false, checked = 0, evaluated = 0;
  const records = new Map(), scores = new Map(), probed = new Map(), pending = new Map();
  const covers = new Map();
  const lookupPending = new Map(), lookupQueue = new Set(), checkedTexts = new Map();
  const send = async m => { const r = await chrome.runtime.sendMessage(m); if (r?.error) throw new Error(r.error); return r; };
  const textOf = node => (node.innerText || '').replace(/\s+/g, ' ').trim();
  const remember = (map, key, value) => {
    map.delete(key); map.set(key, value);
    if (map.size > MAX) map.delete(map.keys().next().value);
  };
  const active = () => config.enabled && config.configured && !paused;
  const eligible = node => {
    if (!node.isConnected || node.closest(adaptor.exclude) || node.closest('a, button, [role="button"]') ||
        (adaptor.eligible && !adaptor.eligible(node))) return false;
    if (['hidden', 'collapse'].includes(getComputedStyle(node).visibility)) return false;
    for (let p = node; p && p.nodeType === 1; p = p.parentElement)
      if (getComputedStyle(p).display === 'none') return false;
    const r = node.getBoundingClientRect();
    return r.width > 30 && r.height > 12;
  };
  const valid = (node, text) => eligible(node) && textOf(node) === text;
  // Cover grouping comes from the active adaptor (shipped: whole tweets).
  const targetOf = node => adaptor.targetOf(node);
  const distance = node => {
    const r = node.getBoundingClientRect();
    return Math.max(0, r.top - innerHeight, -r.bottom) + Math.max(0, r.left - innerWidth, -r.right);
  };
  const status = () => ({enabled: config.enabled, configured: config.configured, busy, error, paused, checked,
    evaluated, covered: [...covers.values()].filter(c => c.node.isConnected).length,
    limit: evaluated >= config.limit});
  const markChecked = text => {
    if (!checkedTexts.has(text)) checked++;
    remember(checkedTexts, text, true);
  };

  function removeCover(group) {
    group.host.remove();
    if (group.position && group.node.style.position === 'relative') {
      if (group.position.value) group.node.style.setProperty('position', group.position.value, group.position.priority);
      else group.node.style.removeProperty('position');
    }
    for (const record of group.records) record.group = null;
    covers.delete(group.node);
  }
  function uncover(record) {
    const group = record.group;
    if (!group) return;
    record.group = null;
    group.records.delete(record);
    if (!group.records.size) removeCover(group);
  }
  function cover(record) {
    if (record.group || record.revealed || record.score < config.threshold || !active() || !valid(record.node, record.text)) return;
    const node = targetOf(record.node);
    let group = covers.get(node);
    if (group) {
      group.records.add(record); record.group = group; return;
    }
    group = {node, records: new Set([record]), position: null, host: null};
    if (getComputedStyle(node).position === 'static') {
      group.position = {value: node.style.getPropertyValue('position'), priority: node.style.getPropertyPriority('position')};
      node.style.setProperty('position', 'relative', 'important');
    }
    const host = document.createElement('span');
    host.dataset.slopShield = 'cover';
    host.style.cssText = 'all:initial!important;position:absolute!important;inset:0!important;display:block!important;z-index:2147483647!important;background:#fff!important;border-radius:4px!important;min-height:0!important;box-sizing:border-box!important;';
    const shadow = host.attachShadow({mode: 'closed'});
    const style = document.createElement('style');
    style.textContent = `:host{color-scheme:light}button{appearance:none;box-sizing:border-box;position:absolute;inset:0;width:100%;height:100%;background:#fff;color:#656760;border:1px solid #e6e7e1;border-radius:4px;display:flex;align-items:center;justify-content:center;gap:9px;font:11px/1.3 system-ui,sans-serif;letter-spacing:.02em;cursor:pointer;overflow:hidden;padding:3px 8px}button:hover{border-color:#b3b7a9;color:#292c23}button:focus-visible{outline:3px solid #57743b;outline-offset:2px}.dot{width:6px;height:6px;background:#a8b79a;border-radius:50%;flex-shrink:0}small{font:inherit;color:#91948a}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', `Reveal ${node !== record.node ? 'tweet and attached images' : 'content'} matching your filter. Match score ${Math.round(record.score * 100)} out of 100.`);
    button.title = 'Click to reveal. Content matches can be wrong.';
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span'); label.textContent = 'Hidden by your filter';
    const hint = document.createElement('small'); hint.textContent = '· reveal';
    button.append(dot, label, hint);
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      // Multiple flagged passages in a tweet share one cover and reveal action.
      for (const item of records.values()) if (targetOf(item.node) === node) item.revealed = true;
      removeCover(group);
    });
    shadow.append(style, button);
    group.host = host; record.group = group; covers.set(node, group);
    node.append(host);
  }
  function clean() {
    for (const [node, record] of records) {
      if (!valid(node, record.text)) { uncover(record); records.delete(node); }
      else {
        if (record.group && record.group.host.parentElement !== record.group.node) removeCover(record.group);
        if (record.group && record.group.node !== targetOf(node)) uncover(record);
        cover(record);
      }
    }
  }
  function apply(node, text, score) {
    if (!active() || !valid(node, text)) return;
    let record = records.get(node);
    if (record?.text === text) return;
    if (record) uncover(record);
    record = {node, text, score, revealed: false, group: null};
    records.set(node, record);
    markChecked(text);
    cover(record);
  }
  function discover() {
    if (!active()) return;
    // Discovery and cached covers continue while DETECT is busy or its budget
    // is exhausted. Feed nodes are temporary; the text score cache is not.
    clean(); pending.clear(); lookupQueue.clear();
    // Roots come from the active adaptor: the document by default, plus every
    // reachable open shadow root when the adaptor opts in (generic).
    const scanRoots = adaptor.roots?.() ?? [document];
    for (const node of scanRoots.flatMap(root => [...root.querySelectorAll(adaptor.candidates)])) {
      // A container candidate swallows its subtree: inner candidates are
      // skipped, and the container is kept even when it wraps other candidates.
      if (adaptor.container && node.closest(adaptor.container) && !node.matches(adaptor.container)) continue;
      if (node.querySelector(adaptor.candidates) && !(adaptor.container && node.matches(adaptor.container))) continue;
      if (!eligible(node)) continue;
      const text = textOf(node);
      if (text.length < adaptor.minText(node) || text.length > 4000) continue;
      if (records.get(node)?.text === text) continue;
      if (scores.has(text)) {
        const score = scores.get(text);
        remember(scores, text, score);
        apply(node, text, score); continue;
      }
      if ((!pending.has(text) && pending.size < MAX) || (pending.has(text) && distance(node) < distance(pending.get(text)))) pending.set(text, node);
      if (pending.has(text) && !probed.has(text) && !lookupPending.has(text) && lookupQueue.size < MAX) lookupQueue.add(text);
    }
    // A miss belongs to the mounted page, not the lifetime of a text passage.
    // Reinserted passages can have gained a persistent score in another tab.
    for (const text of probed.keys()) if (!pending.has(text) && !lookupPending.has(text)) probed.delete(text);
    flushLookup(); detect();
  }
  function flushLookup() {
    if (lookupBusy || !active() || !lookupQueue.size) return;
    lookupBusy = true;
    const texts = [...lookupQueue].sort((a, b) => distance(pending.get(a)) - distance(pending.get(b))).slice(0, 64);
    const version = epoch;
    for (const text of texts) { lookupQueue.delete(text); lookupPending.set(text, version); }
    send({type: 'CACHE_LOOKUP', texts, filterId: config.filterId}).then(async response => {
      if (version !== epoch || !active()) return;
      if (response?.stale) { await configure(); return; }
      const values = response?.scores;
      if (!Array.isArray(values) || values.length !== texts.length) {
        texts.forEach(text => remember(probed, text, true));
        return;
      }
      texts.forEach((text, i) => {
        remember(probed, text, true);
        if (Number.isFinite(values[i]) && values[i] >= 0 && values[i] <= 1) {
          remember(scores, text, values[i]); markChecked(text);
        }
      });
    }).catch(() => {
      if (version === epoch) texts.forEach(text => remember(probed, text, true));
    }).finally(() => {
      texts.forEach(text => { if (lookupPending.get(text) === version) lookupPending.delete(text); });
      lookupBusy = false;
      schedule();
    });
  }
  async function detect() {
    if (busy || !active() || error || document.hidden || evaluated >= config.limit) return;
    const choices = [...pending].filter(([text, node]) => probed.has(text) && !lookupPending.has(text) && !scores.has(text) && valid(node, text));
    if (!choices.length) return;
    choices.sort((a, b) => distance(a[1]) - distance(b[1]));
    const [text] = choices[0];
    busy = true;
    const version = epoch;
    try {
      const response = await send({type: 'DETECT', text, filterId: config.filterId});
      if (version !== epoch || !active()) return;
      if (response?.stale) { await configure(); return; }
      if (!Number.isFinite(response?.score) || response.score < 0 || response.score > 1) throw new Error('Invalid score from Jev.');
      remember(scores, text, response.score);
      markChecked(text);
      if (response.source === 'api') evaluated++;
    } catch (e) { if (version === epoch) error = e.message || 'Unable to reach Jev.'; }
    finally { busy = false; schedule(); }
  }
  function schedule() {
    if (timer || !active()) return;
    // Coalesce events without resetting the timer on every scroll/mutation.
    timer = setTimeout(() => { timer = null; discover(); }, 0);
  }
  function reset() {
    epoch++; error = ''; checked = 0; evaluated = 0; paused = false;
    clearTimeout(timer); timer = null;
    for (const record of records.values()) uncover(record);
    records.clear(); pending.clear(); lookupQueue.clear(); lookupPending.clear(); checkedTexts.clear(); probed.clear();
  }
  async function configure() {
    const request = ++configRequest;
    try {
      const next = await send({type: 'CONFIG'});
      if (request !== configRequest) return;
      if (next.filterId !== config.filterId) {
        // Scores/reveal decisions are meaningful only under the same rule.
        // The persistent worker cache keeps older rule scores separately.
        reset(); scores.clear();
      }
      epoch++; error = ''; config = next;
      lookupQueue.clear(); lookupPending.clear(); probed.clear();
      if (!config.enabled || !config.configured) { observer?.disconnect(); reset(); return; }
      for (const record of records.values()) { uncover(record); if (!paused) cover(record); }
      observer ||= new MutationObserver(mutations => {
        const relevant = mutations.some(m => !m.target.closest?.('[data-slop-shield]') &&
          !(m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType === 1 && n.hasAttribute('data-slop-shield'))));
        if (relevant) schedule();
      });
      observer.observe(document.body, adaptor.observe ?? {subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'contenteditable', 'role', 'data-testid', 'dir']});
      schedule();
    } catch (e) { if (request === configRequest) error = e.message; }
  }
  chrome.runtime.onMessage.addListener((m, _sender, respond) => {
    if (m.type === 'STATUS') { clean(); respond(status()); }
    if (m.type === 'CONFIG_CHANGED') { configure().then(() => respond(status())); return true; }
    if (m.type === 'RESCAN') { reset(); schedule(); respond(status()); }
    if (m.type === 'REVEAL_ALL') {
      epoch++; paused = true; clearTimeout(timer); timer = null;
      for (const record of records.values()) { record.revealed = true; uncover(record); }
      respond(status());
    }
  });
  addEventListener('scroll', schedule, {passive: true, capture: true});
  addEventListener('resize', schedule, {passive: true});
  document.addEventListener('visibilitychange', schedule);
  configure();
})();
