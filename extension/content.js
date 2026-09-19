(() => {
  if (globalThis.__slopShield) return;
  globalThis.__slopShield = true;
  const SELECTOR = 'p, li, blockquote, [data-testid="tweetText"], [data-ad-preview="message"], .md > div, div[dir="auto"]';
  const EXCLUDE = 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [aria-hidden="true"], [hidden], [data-slop-shield]';
  let config = {enabled: false, configured: false, threshold: .85, limit: 120};
  let epoch = 0, busy = false, error = '', timer, observer, paused = false, checked = 0;
  let records = new Map(), seen = new WeakMap();
  const send = async (m) => { const r = await chrome.runtime.sendMessage(m); if (r?.error) throw new Error(r.error); return r; };
  const textOf = node => (node.innerText || '').replace(/\s+/g, ' ').trim();
  const visible = node => {
    const r = node.getBoundingClientRect();
    return r.width > 30 && r.height > 12 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && getComputedStyle(node).visibility !== 'hidden';
  };
  const status = () => ({enabled: config.enabled, configured: config.configured, busy, error, paused, checked,
    covered: [...records.values()].filter(r => r.host && r.node.isConnected).length, limit: checked >= config.limit});

  function uncover(record) {
    record.host?.remove(); record.host = null;
    if (record.position && record.node.style.position === 'relative') {
      if (record.position.value) record.node.style.setProperty('position', record.position.value, record.position.priority);
      else record.node.style.removeProperty('position');
    }
    record.position = null;
  }

  function cover(record) {
    if (record.host || record.revealed || record.score < config.threshold || !record.node.isConnected) return;
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
    button.setAttribute('aria-label', `Reveal likely AI slop. Jev score ${Math.round(record.score * 100)} out of 100. This is a style estimate, not proof of AI authorship.`);
    button.title = 'Click to reveal. AI-style judgments can be wrong.';
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span'); label.textContent = 'Likely AI slop';
    const hint = document.createElement('small'); hint.textContent = '· reveal';
    button.append(dot, label, hint);
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); record.revealed = true; uncover(record); });
    shadow.append(style, button);
    record.host = host;
    node.append(host);
  }

  function clean() {
    for (const [node, record] of records) {
      if (!node.isConnected || textOf(node) !== record.text || node.closest(EXCLUDE)) {
        uncover(record); records.delete(node); seen.delete(node);
      }
    }
  }

  function candidate() {
    for (const node of document.querySelectorAll(SELECTOR)) {
      if (node.closest(EXCLUDE) || node.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"]), img, video, iframe') || !visible(node)) continue;
      if (node.querySelector(SELECTOR)) continue;
      if (node.closest('a, button, [role="button"]')) continue;
      const text = textOf(node);
      if (text.length < 80 || text.length > 4000 || seen.get(node) === text) continue;
      return {node, text};
    }
    return null;
  }

  async function scan() {
    if (busy || !config.enabled || !config.configured || paused || error || document.hidden || checked >= config.limit) return;
    clean();
    const item = candidate();
    if (!item) return;
    busy = true;
    const version = epoch;
    try {
      const response = await send({type: 'DETECT', text: item.text});
      if (version !== epoch || !item.node.isConnected || textOf(item.node) !== item.text || item.node.closest(EXCLUDE)) return;
      if (!Number.isFinite(response.score)) return;
      seen.set(item.node, item.text); checked++;
      const record = {...item, score: response.score, revealed: false, host: null};
      records.set(item.node, record); cover(record);
    } catch (e) { if (version === epoch) error = e.message || 'Unable to reach Jev.'; }
    finally { busy = false; schedule(); }
  }

  function schedule() { clearTimeout(timer); if (config.enabled && !paused) timer = setTimeout(scan, 400); }
  function reset() {
    epoch++; error = ''; checked = 0; paused = false;
    for (const record of records.values()) uncover(record);
    records = new Map(); seen = new WeakMap();
  }
  async function configure() {
    try {
      const next = await send({type: 'CONFIG'});
      epoch++; error = ''; config = next;
      if (!config.enabled || !config.configured) {
        observer?.disconnect(); clearTimeout(timer); reset(); return;
      }
      for (const record of records.values()) { uncover(record); if (!paused) cover(record); }
      observer ||= new MutationObserver(mutations => {
        const relevant = mutations.some(m => !m.target.closest?.('[data-slop-shield]') &&
          !(m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType === 1 && n.hasAttribute('data-slop-shield'))));
        if (relevant) { clean(); schedule(); }
      });
      observer.observe(document.body, {subtree: true, childList: true, characterData: true});
      schedule();
    } catch (e) { error = e.message; }
  }
  chrome.runtime.onMessage.addListener((m, _sender, respond) => {
    if (m.type === 'STATUS') { clean(); respond(status()); }
    if (m.type === 'CONFIG_CHANGED') { configure().then(() => respond(status())); return true; }
    if (m.type === 'RESCAN') { reset(); schedule(); respond(status()); }
    if (m.type === 'REVEAL_ALL') {
      epoch++; paused = true; clearTimeout(timer);
      for (const record of records.values()) { record.revealed = true; uncover(record); }
      respond(status());
    }
  });
  addEventListener('scroll', schedule, {passive: true, capture: true});
  addEventListener('resize', schedule, {passive: true});
  document.addEventListener('visibilitychange', schedule);
  configure();
})();
