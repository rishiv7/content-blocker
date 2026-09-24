import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

class Control {
  constructor() { this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.events = {}; this.children = []; this.attrs = {}; this.type = 'password'; this.classList = {toggle() {}}; }
  addEventListener(type, fn) { this.events[type] = fn; }
  setAttribute(key, value) { this.attrs[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}
const initial = {configured: true, compilerAgent: 'content-blocker-compiler', filterReady: true, instruction: 'No travel',
  filterSummary: 'Hide travel content', filterId: 'one', threshold: .85, sites: ['https://example.com'], shortForm: false};
async function fixture(name = 'popup', overrides = {}) {
  const [html, source] = await Promise.all(['html', 'js'].map(ext => readFile(new URL(`../extension/${name}.${ext}`, import.meta.url), 'utf8')));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs are unique');
  const controls = Object.fromEntries(ids.map(id => [id, new Control()]));
  const settings = {...structuredClone(initial), ...overrides}, requests = [], hooks = {};
  const document = {activeElement: null, getElementById(id) { assert.ok(controls[id], `Missing ${name} element: ${id}`); return controls[id]; }, createElement: () => new Control()};
  let interval;
  await vm.runInNewContext(`(async () => {${source}\n})()`, {
    document, URL, setInterval: fn => { interval = fn; },
    chrome: {
      runtime: {openOptionsPage() {}, sendMessage: async m => {
        requests.push(structuredClone(m));
        if (hooks[m.type]) return hooks[m.type](m);
        if (m.type === 'GET_SETTINGS') return structuredClone(settings);
        if (m.type === 'SAVE_INSTRUCTION') {
          Object.assign(settings, {instruction: m.instruction, filterReady: !!m.instruction, filterSummary: m.instruction ? 'Updated rule' : '', filterId: m.instruction ? 'two' : null});
        }
        if (m.type === 'SAVE_SETTINGS') {
          settings.threshold = m.threshold;
          if (m.apiKey !== undefined) settings.configured = !!m.apiKey;
          if (m.openaiApiKey !== undefined) settings.openaiConfigured = !!m.openaiApiKey;
          if (m.shortForm !== undefined) settings.shortForm = m.shortForm;
        }
        return {ok: true};
      }},
      tabs: {query: async () => [{id: 1, url: 'https://example.com/feed'}], sendMessage: async () => ({checked: 4, covered: 1})},
      permissions: {request: async () => true}
    }
  });
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  return {controls, settings, requests, hooks, document, flush, refresh: async () => { interval?.(); await flush(); }};
}

test('popup retains edited drafts through polling and saves a global instruction', async () => {
  const h = await fixture(), c = h.controls;
  assert.equal(c.instruction.value, 'No travel');
  c.instruction.value = 'No travel, but allow local news'; c.instruction.events.input();
  await h.refresh();
  assert.equal(c.instruction.value, 'No travel, but allow local news');
  await c.apply.events.click();
  const saved = h.requests.find(m => m.type === 'SAVE_INSTRUCTION');
  assert.deepEqual(saved, {type: 'SAVE_INSTRUCTION', instruction: 'No travel, but allow local news'});
  assert.equal(c['active-summary'].textContent, 'Updated rule');
  assert.match(c['rule-message'].textContent, /saved and applied/);
});

test('popup preserves failed drafts and shows the still-active saved rule', async () => {
  const h = await fixture(), c = h.controls;
  h.hooks.SAVE_INSTRUCTION = async () => ({error: 'TrueForge unavailable.'});
  c.instruction.value = 'No politics'; c.instruction.events.input();
  await c.apply.events.click(); await h.refresh();
  assert.equal(c.instruction.value, 'No politics');
  assert.equal(c['active-summary'].textContent, 'Hide travel content');
  assert.match(c['rule-message'].textContent, /previous filter is still active/);
});

test('clearing a rule works without an OpenAI key and does not report active filtering', async () => {
  const h = await fixture('popup', {openaiConfigured: false}), c = h.controls;
  assert.equal(c.apply.disabled, false, 'saving no longer needs an extension OpenAI key');
  await c['clear-rule'].events.click();
  assert.equal(c.instruction.value, '');
  assert.equal(c['active-summary'].textContent, 'No active filter');
  assert.equal(c.status.textContent, 'Save a filter to start');
  assert.equal(c.toggle.disabled, false, 'an enabled site can still be switched off');
  assert.equal(c.rescan.disabled, true);
});

test('typing while a save is pending does not lose the newer draft or send a duplicate request', async () => {
  const h = await fixture(), c = h.controls;
  let resolve;
  h.hooks.SAVE_INSTRUCTION = () => new Promise(done => { resolve = done; });
  c.instruction.value = 'No politics'; c.instruction.events.input();
  const saving = c.apply.events.click();
  await c.apply.events.click();
  c.instruction.value = 'No politics or travel'; c.instruction.events.input();
  Object.assign(h.settings, {instruction: 'No politics', filterSummary: 'Hide politics'});
  resolve({ok: true}); await saving; await h.refresh();
  assert.equal(c.instruction.value, 'No politics or travel');
  assert.equal(h.requests.filter(m => m.type === 'SAVE_INSTRUCTION').length, 1);
});

test('settings submits keys only when entered, preserves saved keys on blank fields, and removes explicitly', async () => {
  const h = await fixture('options'), c = h.controls;
  const submit = () => c.form.events.submit({preventDefault() {}});
  c.key.value = 'example-jev-key';
  await submit();
  assert.deepEqual(h.requests.find(m => m.type === 'SAVE_SETTINGS'), {type: 'SAVE_SETTINGS', threshold: .85,
    apiKey: 'example-jev-key'});
  assert.equal(c.key.value, '');
  await submit();
  assert.deepEqual(h.requests.filter(m => m.type === 'SAVE_SETTINGS').at(-1), {type: 'SAVE_SETTINGS', threshold: .85});
  await c['remove-key'].events.click();
  assert.equal(h.requests.filter(m => m.type === 'SAVE_SETTINGS').at(-1).apiKey, '');
  assert.equal(c.test.disabled, true, 'Jev testing needs the TypeSafe key');
});
test('short-form toggle round-trips through SAVE_SETTINGS and reflects saved state', async () => {
  const h = await fixture('popup', {shortForm: true}), c = h.controls;
  assert.equal(c['short-form'].checked, true, 'the saved mode is reflected on popup open');
  c['short-form'].checked = false;
  await c['short-form'].events.change();
  assert.deepEqual(h.requests.filter(m => m.type === 'SAVE_SETTINGS').at(-1), {type: 'SAVE_SETTINGS', threshold: .85, shortForm: false}, 'the current threshold rides along with the mode');
  assert.equal(c['short-form'].checked, false, 'the stored state holds after the save');
  c['short-form'].checked = true;
  await c['short-form'].events.change();
  assert.deepEqual(h.requests.filter(m => m.type === 'SAVE_SETTINGS').at(-1).shortForm, true);
  assert.equal(h.settings.shortForm, true, 'the fixture stored the new mode');
});
test('an in-flight short-form save is not overwritten by polling', async () => {
  const h = await fixture('popup'), c = h.controls;
  let resolve;
  h.hooks.SAVE_SETTINGS = () => new Promise(done => { resolve = done; });
  c['short-form'].checked = true;
  const saving = c['short-form'].events.change();
  assert.equal(c['short-form'].disabled, true, 'the checkbox locks while saving');
  await h.refresh();
  assert.equal(c['short-form'].checked, true, 'the 1s poll keeps the in-flight state');
  Object.assign(h.settings, {shortForm: true});
  resolve({ok: true}); await saving; await h.refresh();
  assert.equal(c['short-form'].disabled, false, 'the checkbox unlocks after the save');
  assert.equal(c['short-form'].checked, true);
});
test('status line names the deterministic mode when no filter exists', async () => {
  const noFilter = {filterReady: false, instruction: '', filterId: null, filterSummary: ''};
  const h = await fixture('popup', {...noFilter, shortForm: true}), c = h.controls;
  assert.equal(c.status.textContent, 'Blocking short-form video');
  const withoutMode = await fixture('popup', noFilter);
  assert.equal(withoutMode.controls.status.textContent, 'Save a filter to start');
  const withFilter = await fixture('popup', {shortForm: true});
  assert.equal(withFilter.controls.status.textContent, 'Filtering this site');
});
test('short-form mode relaxes the site gate without touching today\'s gates', async () => {
  const gated = {configured: false, openaiConfigured: false, filterReady: false, sites: []};
  const h = await fixture('popup', {...gated, shortForm: true}), c = h.controls;
  assert.equal(c.toggle.disabled, false, 'a site can be enabled with no key and no rule');
  assert.equal(c.status.textContent, 'Off on this site');
  const today = await fixture('popup', gated);
  assert.equal(today.controls.toggle.disabled, true, 'short-form off: today\'s gate stands');
  assert.equal(today.controls.status.textContent, 'Add a TypeSafe key in Settings');
});
