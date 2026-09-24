import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const event = () => ({addListener() {}});
const storage = initial => {
  let data = structuredClone(initial);
  return {
    async setAccessLevel() {},
    async get(keys) {
      if (typeof keys === 'string') return {[keys]: structuredClone(data[keys])};
      return Object.fromEntries(keys.filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    },
    async set(values) { data = {...data, ...structuredClone(values)}; },
    snapshot() { return structuredClone(data); }
  };
};
const filter = {id: 'a'.repeat(64), instruction: 'No travel content', summary: 'Hide travel',
  question: {type: 'noul', instructions: 'Block travel content.', criteria: {true: 'Discusses travel', false: 'Unrelated to travel'}}};
const trusted = {id: 'test-extension', url: 'chrome-extension://test-extension/popup.html'};
const page = origin => ({id: 'test-extension', tab: {id: 1}, url: `${origin}/feed`});
let instance = 0;

async function fixture(t, initial = {}, {granted = true, tabUrl} = {}) {
  const previousChrome = globalThis.chrome;
  let listener;
  const local = storage({apiKey: '', openaiApiKey: '', filter: null, threshold: .85, sites: [], shortForm: false, ...initial});
  const injected = [];
  globalThis.chrome = {
    storage: {local, session: storage({})},
    runtime: {
      id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: {addListener(fn) { listener = fn; }}, onInstalled: event(), onStartup: event()
    },
    permissions: {onRemoved: event(), contains: async () => granted},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {},
      unregisterContentScripts: async () => {}, executeScript: async args => injected.push(args)},
    tabs: {onRemoved: event(), query: async () => [{id: 1}], get: async id => ({id, url: tabUrl ?? 'about:blank'}), sendMessage: async () => {}}
  };
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  t.after(() => { globalThis.chrome = previousChrome; });
  await import(`../extension/background.js?test=${++instance}`);
  const send = (message, from = trusted) => new Promise(resolve => listener(message, from, resolve));
  return {send, local, injected};
}

test('short-form on enables a site with no API key and no compiled filter', async t => {
  const h = await fixture(t, {shortForm: true}, {tabUrl: 'https://youtube.com/shorts/x'});
  assert.deepEqual(await h.send({type: 'SET_SITE', origin: 'https://youtube.com', enabled: true, tabId: 1}), {ok: true});
  assert.deepEqual(h.local.snapshot().sites, ['https://youtube.com']);
  assert.deepEqual(h.injected[0], {target: {tabId: 1}, files: ['content.js']}, 'the enabled site is injected immediately as today');
});

test('short-form off keeps today\'s exact SET_SITE errors', async t => {
  const noKey = await fixture(t, {shortForm: false});
  assert.equal((await noKey.send({type: 'SET_SITE', origin: 'https://youtube.com', enabled: true})).error, 'Add an API key first.');
  assert.deepEqual(noKey.local.snapshot().sites, [], 'the site list is untouched by a failed enable');
  const noFilter = await fixture(t, {apiKey: 'jev-test-key', filter: null, shortForm: false});
  assert.equal((await noFilter.send({type: 'SET_SITE', origin: 'https://youtube.com', enabled: true})).error, 'Save a blocking instruction in the popup first.');
  const today = await fixture(t, {apiKey: 'jev-test-key', filter, shortForm: false}, {tabUrl: 'https://youtube.com/watch'});
  assert.deepEqual(await today.send({type: 'SET_SITE', origin: 'https://youtube.com', enabled: true, tabId: 1}), {ok: true});
  assert.deepEqual(today.local.snapshot().sites, ['https://youtube.com']);
});

test('site permission is required before enabling, with or without short-form', async t => {
  const shortFormOn = await fixture(t, {shortForm: true}, {granted: false});
  assert.equal((await shortFormOn.send({type: 'SET_SITE', origin: 'https://youtube.com', enabled: true})).error, 'Site permission was not granted.');
  const shortFormOff = await fixture(t, {apiKey: 'jev-test-key', filter, shortForm: false}, {granted: false});
  assert.equal((await shortFormOff.send({type: 'SET_SITE', origin: 'https://youtube.com', enabled: true})).error, 'Site permission was not granted.');
});

test('SAVE_SETTINGS validates shortForm as a boolean and persists it', async t => {
  const h = await fixture(t);
  assert.equal((await h.send({type: 'SAVE_SETTINGS', threshold: .85, shortForm: true})).ok, true);
  assert.equal(h.local.snapshot().shortForm, true);
  assert.equal((await h.send({type: 'SAVE_SETTINGS', threshold: .85, shortForm: 'yes'})).error, 'Invalid short-form setting.');
  assert.equal((await h.send({type: 'SAVE_SETTINGS', threshold: .85, shortForm: 1})).error, 'Invalid short-form setting.');
  assert.equal(h.local.snapshot().shortForm, true, 'a rejected value does not overwrite the stored setting');
  assert.equal((await h.send({type: 'SAVE_SETTINGS', threshold: .85, shortForm: false})).ok, true);
  assert.equal(h.local.snapshot().shortForm, false);
});

test('publicConfig carries shortForm to content scripts with no key involved', async t => {
  const h = await fixture(t, {shortForm: true, sites: ['https://youtube.com']});
  assert.deepEqual(await h.send({type: 'CONFIG'}, page('https://youtube.com')),
    {configured: false, threshold: .85, enabled: true, shortForm: true, filterId: null, limit: 120});
  assert.equal((await h.send({type: 'CONFIG'}, page('https://tiktok.com'))).shortForm, true, 'the flag is global, not per-origin');
  const off = await fixture(t, {apiKey: 'jev-test-key', filter});
  assert.equal((await off.send({type: 'CONFIG'}, page('https://youtube.com'))).shortForm, false);
});
