import {detect, buildRequest, normalizePassage} from './jev.js';
import {ScoreCache} from './score-cache.js';
import {RequestLog, redact, responsePreview} from './request-log.js';

const defaults = {apiKey: '', threshold: 0.85, sites: []};
const ready = chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
const sessionReady = chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
const log = new RequestLog({
  get: async key => { await sessionReady; return chrome.storage.session.get(key); },
  set: async values => { await sessionReady; return chrome.storage.session.set(values); }
});
const cache = new ScoreCache({
  get: async key => { await ready; return chrome.storage.local.get(key); },
  set: async values => { await ready; return chrome.storage.local.set(values); }
});
const network = new Map();
const active = new Map();
const quotas = new Map();
let revision = 0;
const read = async () => { await ready; return {...defaults, ...await chrome.storage.local.get(Object.keys(defaults))}; };
const publicConfig = (s, origin) => ({configured: !!s.apiKey, threshold: s.threshold, enabled: s.sites.includes(origin), limit: 120});
const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };
const trusted = (sender) => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
const pattern = (origin) => { const u = new URL(origin); return `${u.protocol}//${u.hostname}/*`; };
const hash = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), x => x.toString(16).padStart(2, '0')).join('');

// Log-storage failures must not fail classification.
async function loggedDetect(text, apiKey, signal, context = {}) {
  const startedAt = Date.now();
  const entry = {kind: 'api', state: 'pending', startedAt, passage: text, ...context,
    request: {method: 'POST', url: 'https://api.typesafe.ai/v1/systemone', body: buildRequest(text)},
    response: null, score: null, error: null};
  const id = await log.start(redact(entry, apiKey)).catch(() => null);
  try {
    const score = await detect(text, apiKey, signal, async (url, init) => {
      const response = await fetch(url, init);
      if (id) {
        const preview = await responsePreview(response).catch(() => ({body: '[Response body could not be captured]', truncated: false}));
        await log.update(id, redact({response: {status: response.status, ...preview}}, apiKey)).catch(() => {});
      }
      return response;
    });
    await log.update(id, {state: 'success', score, durationMs: Date.now() - startedAt}).catch(() => {});
    return score;
  } catch (error) {
    await log.update(id, redact({state: 'error', error: error.message, durationMs: Date.now() - startedAt}, apiKey)).catch(() => {});
    throw error;
  }
}

async function reconcile(s) {
  const current = await chrome.scripting.getRegisteredContentScripts();
  const wanted = new Map();
  for (const origin of s.sites) {
    const match = pattern(origin);
    if (await chrome.permissions.contains({origins: [match]})) wanted.set(`slop-${(await hash(match)).slice(0, 20)}`, match);
  }
  const remove = current.filter(x => x.id.startsWith('slop-') && !wanted.has(x.id)).map(x => x.id);
  if (remove.length) await chrome.scripting.unregisterContentScripts({ids: remove});
  const add = [...wanted].filter(([id]) => !current.some(x => x.id === id));
  if (add.length) await chrome.scripting.registerContentScripts(add.map(([id, match]) => ({id, matches: [match], js: ['content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true})));
}

async function changed() {
  revision++;
  for (const controller of network.values()) controller.abort();
  const s = await read();
  await reconcile(s);
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {type: 'CONFIG_CHANGED'})));
}

async function classify(message, sender) {
  const origin = originOf(sender.url);
  const s = await read();
  if (!sender.tab || !origin || !s.sites.includes(origin)) throw new Error('Filtering is off for this site.');
  if (!s.apiKey) throw new Error('Add your TypeSafe API key in Settings.');
  const text = normalizePassage(message.text);
  const documentKey = `${sender.tab.id}:${sender.documentId || sender.url}`;
  if (active.has(documentKey)) throw new Error('A scan is already running.');
  const version = revision;
  const request = {};
  active.set(documentKey, request);
  try {
    // Including the complete request makes model/rubric changes invalidate old scores.
    // Origins, DOM IDs and thresholds do not affect classification or the cache key.
    const key = await hash(JSON.stringify(buildRequest(text)));
    let source;
    const startedAt = Date.now();
    const score = await cache.getOrCompute(key, async () => {
      if (version !== revision || active.get(documentKey) !== request) throw new Error('Scan cancelled.');
      if (network.size >= 4) throw new Error('Other tabs are scanning. Try again shortly.');
      const quota = quotas.get(documentKey) || {count: 0, since: Date.now()};
      if (Date.now() - quota.since > 3600000) { quota.count = 0; quota.since = Date.now(); }
      if (quota.count >= 360) throw new Error('Hourly scan limit reached for this page.');
      quota.count++;
      quotas.set(documentKey, quota);
      if (quotas.size > 500) quotas.delete(quotas.keys().next().value);
      const controller = new AbortController();
      network.set(key, controller);
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const result = await loggedDetect(text, s.apiKey, controller.signal, {origin, passageHash: key});
        if (controller.signal.aborted || version !== revision) throw new Error('Scan cancelled.');
        return result;
      } finally { clearTimeout(timer); network.delete(key); }
    }, value => {source = value;});
    if (source !== 'api') await log.start(redact({kind: source, state: 'success', startedAt, durationMs: Date.now() - startedAt, origin, passageHash: key, passage: text, score, request: null, response: null, error: null}, s.apiKey)).catch(() => {});
    if (version !== revision || active.get(documentKey) !== request) throw new Error('Scan cancelled.');
    return {score};
  } finally { if (active.get(documentKey) === request) active.delete(documentKey); }
}

async function handle(m, sender) {
  if (m.type === 'CONFIG') return publicConfig(await read(), originOf(sender.url));
  if (m.type === 'DETECT') return classify(m, sender);
  if (!trusted(sender)) throw new Error('Not allowed.');
  if (m.type === 'GET_LOGS') return log.snapshot();
  if (m.type === 'CLEAR_LOGS') { await log.clear(); return {ok: true}; }
  if (m.type === 'SET_LOGGING') {
    if (typeof m.enabled !== 'boolean') throw new Error('Invalid logging setting.');
    await log.setEnabled(m.enabled); return {ok: true};
  }
  const s = await read();
  if (m.type === 'GET_SETTINGS') return {configured: !!s.apiKey, threshold: s.threshold, sites: s.sites};
  if (m.type === 'SAVE_SETTINGS') {
    if (!Number.isFinite(m.threshold) || m.threshold < 0.5 || m.threshold > 0.99) throw new Error('Choose a threshold between 50 and 99.');
    const update = {threshold: m.threshold};
    if (m.apiKey !== undefined) {
      if (typeof m.apiKey !== 'string' || m.apiKey.length > 1024 || /\s/.test(m.apiKey)) throw new Error('Enter a valid API key without whitespace.');
      update.apiKey = m.apiKey;
    }
    await chrome.storage.local.set(update); await changed(); return {ok: true};
  }
  if (m.type === 'SET_SITE') {
    const origin = originOf(m.origin);
    if (!origin || origin !== m.origin) throw new Error('Unsupported page.');
    if (m.enabled && !await chrome.permissions.contains({origins: [pattern(origin)]})) throw new Error('Site permission was not granted.');
    if (m.enabled && !s.apiKey) throw new Error('Add an API key first.');
    const sites = s.sites.filter(x => x !== origin);
    if (m.enabled) sites.push(origin);
    await chrome.storage.local.set({sites}); await changed();
    if (m.enabled && Number.isInteger(m.tabId)) {
      const tab = await chrome.tabs.get(m.tabId);
      if (originOf(tab.url) === origin) await chrome.scripting.executeScript({target: {tabId: m.tabId}, files: ['content.js']});
    }
    return {ok: true};
  }
  if (m.type === 'TEST') {
    await loggedDetect('The library opens at nine on weekdays. To renew a book, bring your library card to the front desk before the due date.', s.apiKey, AbortSignal.timeout(20000), {origin: 'Connection test'});
    return {ok: true};
  }
  throw new Error('Unknown request.');
}

chrome.runtime.onMessage.addListener((m, sender, respond) => {
  handle(m || {}, sender).then(respond).catch(error => respond({error: error.name === 'AbortError' || error.name === 'TimeoutError' ? 'Scan timed out or was cancelled. Try again.' : error.message}));
  return true;
});
chrome.runtime.onInstalled.addListener(() => read().then(reconcile).catch(() => {}));
chrome.runtime.onStartup.addListener(() => read().then(reconcile).catch(() => {}));
chrome.permissions.onRemoved.addListener(() => (async () => {
  const s = await read();
  const sites = [];
  for (const origin of s.sites) if (await chrome.permissions.contains({origins: [pattern(origin)]})) sites.push(origin);
  await chrome.storage.local.set({sites});
  await changed();
})().catch(() => {}));
chrome.tabs.onRemoved.addListener(id => {
  // A shared request can still serve another tab and populate the cache.
  for (const key of active.keys()) if (key.startsWith(`${id}:`)) active.delete(key);
  for (const key of quotas.keys()) if (key.startsWith(`${id}:`)) quotas.delete(key);
});
