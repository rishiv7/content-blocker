(() => {
  if (globalThis.__slopShield) return;
  globalThis.__slopShield = true;
  const SELECTOR = 'p, li, blockquote, [data-testid="tweetText"], [data-ad-preview="message"], .md > div, div[dir="auto"]';
  const EXCLUDE = 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [aria-hidden="true"], [hidden], [data-slop-shield]';
  const MAX = 10000;
  let config = {enabled: false, configured: false, threshold: .85, limit: 120, filterId: null};
  let epoch = 0, configRequest = 0, busy = false, lookupBusy = false, error = '', timer, observer, paused = false, checked = 0, evaluated = 0;
  const records = new Map(), scores = new Map(), probed = new Map(), pending = new Map();
  const lookupPending = new Map(), lookupQueue = new Set(), checkedTexts = new Map();
  const send = async m => { const r = await chrome.runtime.sendMessage(m); if (r?.error) throw new Error(r.error); return r; };
  const textOf = node => (node.innerText || '').replace(/\s+/g, ' ').trim();
  const remember = (map, key, value) => {
    map.delete(key); map.set(key, value);
    if (map.size > MAX) map.delete(map.keys().next().value);
  };
  const active = () => config.enabled && config.configured && !paused;
  const eligible = node => {
    if (!node.isConnected || node.closest(EXCLUDE) || node.closest('a, button, [role="button"]') ||
        node.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"]), img, video, iframe')) return false;
    if (['hidden', 'collapse'].includes(getComputedStyle(node).visibility)) return false;
    for (let p = node; p && p.nodeType === 1; p = p.parentElement)
      if (getComputedStyle(p).display === 'none') return false;
    const r = node.getBoundingClientRect();
    return r.width > 30 && r.height > 12;
  };
  const valid = (node, text) => eligible(node) && textOf(node) === text;
  const distance = node => {
    const r = node.getBoundingClientRect();
    return Math.max(0, r.top - innerHeight, -r.bottom) + Math.max(0, r.left - innerWidth, -r.right);
  };
  const status = () => ({enabled: config.enabled, configured: config.configured, busy, error, paused, checked,
    evaluated, covered: [...records.values()].filter(r => r.host && r.node.isConnected).length,
    limit: evaluated >= config.limit});
  const markChecked = text => {
    if (!checkedTexts.has(text)) checked++;
    remember(checkedTexts, text, true);
  };

  function uncover(record) {
    record.host?.remove(); record.host = null;
    if (record.position && record.node.style.position === 'relative') {
      if (record.position.value) record.node.style.setProperty('position', record.position.value, record.position.priority);
      else record.node.style.removeProperty('position');
    }
    record.position = null;
  }
  function cover(record) {
    if (record.host || record.revealed || record.score < config.threshold || !active() || !valid(record.node, record.text)) return;
    const node = record.node;
    if (getComputedStyle(node).position === 'static') {
      record.position = {value: node.style.getPropertyValue('position'), priority: node.style.getPropertyPriority('position')};
      node.style.setProperty('position', 'relative', 'important');
    }
    const host = document.createElement('span');
    host.dataset.slopShield = 'cover';
    host.style.cssText = 'all:initial!important;position:absolute!important;inset:0!important;display:block!important;z-index:2!important;background:#fff!important;border-radius:4px!important;min-height:0!important;box-sizing:border-box!important;';
    const shadow = host.attachShadow({mode: 'closed'});
    const style = document.createElement('style');
    style.textContent = `:host{color-scheme:light}button{appearance:none;box-sizing:border-box;position:absolute;inset:0;width:100%;height:100%;background:#fff;color:#656760;border:1px solid #e6e7e1;border-radius:4px;display:flex;align-items:center;justify-content:center;gap:9px;font:11px/1.3 system-ui,sans-serif;letter-spacing:.02em;cursor:pointer;overflow:hidden;padding:3px 8px}button:hover{border-color:#b3b7a9;color:#292c23}button:focus-visible{outline:3px solid #57743b;outline-offset:2px}.dot{width:6px;height:6px;background:#a8b79a;border-radius:50%;flex-shrink:0}small{font:inherit;color:#91948a}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', `Reveal content matching your filter. Match score ${Math.round(record.score * 100)} out of 100.`);
    button.title = 'Click to reveal. Content matches can be wrong.';
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span'); label.textContent = 'Hidden by your filter';
    const hint = document.createElement('small'); hint.textContent = '· reveal';
    button.append(dot, label, hint);
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); record.revealed = true; uncover(record); });
    shadow.append(style, button);
    record.host = host;
    node.append(host);
  }
  function clean() {
    for (const [node, record] of records) {
      if (!valid(node, record.text)) { uncover(record); records.delete(node); }
      else if (record.host && record.host.parentElement !== node) {
        record.host = null; cover(record);
      }
    }
  }
  function apply(node, text, score) {
    if (!active() || !valid(node, text)) return;
    let record = records.get(node);
    if (record?.text === text) return;
    if (record) uncover(record);
    record = {node, text, score, revealed: false, host: null, position: null};
    records.set(node, record);
    markChecked(text);
    cover(record);
  }
  function discover() {
    if (!active()) return;
    // Discovery and cached covers continue while DETECT is busy or its budget
    // is exhausted. Feed nodes are temporary; the text score cache is not.
    clean(); pending.clear(); lookupQueue.clear();
    for (const node of document.querySelectorAll(SELECTOR)) {
      if (node.closest('[data-testid="tweetText"]') && !node.matches('[data-testid="tweetText"]')) continue;
      if (node.querySelector(SELECTOR) && !node.matches('[data-testid="tweetText"]')) continue;
      if (!eligible(node)) continue;
      const text = textOf(node);
      // Topic preferences can match short tweets; generic page fragments still
      // need enough text to avoid spending requests on tiny interface labels.
      if (text.length < (node.matches('[data-testid="tweetText"]') ? 1 : 20) || text.length > 4000) continue;
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
      observer.observe(document.body, {subtree: true, childList: true, characterData: true,
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
