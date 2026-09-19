import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {client} from '../extension/rule-compiler.js';

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
const passage = suffix => `This is a sufficiently long passage containing specific details about the library opening hours and book returns. ${suffix}`;
const sender = {id: 'test-extension', tab: {id: 1}, documentId: 'document', url: 'https://example.com/feed'};
const trusted = {id: 'test-extension', url: 'chrome-extension://test-extension/popup.html'};
const filter = {id: 'a'.repeat(64), instruction: 'No travel content', summary: 'Hide travel',
  question: {type: 'noul', instructions: 'Block travel content.', criteria: {true: 'Discusses travel', false: 'Unrelated to travel'}}};
const compiledResponse = instruction => ({status: 'done', requiredActions: [], output: {
  type: 'model.message', threadId: 'main', finishReason: 'stop',
  content: JSON.stringify({summary: instruction, instructions: `Does the passage violate this preference: ${instruction}?`,
    block: `Violates ${instruction}`, allow: `Does not violate ${instruction} or matches an exception.`})}});
const scoreResponse = score => Response.json({answers: {should_block: {type: 'noul', noul: score}}});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('Expected async operation did not start');
}
let instance = 0;
async function fixture(t, initial = {}) {
  const previousChrome = globalThis.chrome, previousFetch = globalThis.fetch;
  let listener;
  const local = storage({apiKey: 'jev-test-key', openaiApiKey: 'openai-test-key', filter, sites: ['https://example.com'], threshold: .85, ...initial});
  const requests = [], notifications = [], responses = {
    trueforge: async body => compiledResponse(body.input[0].content), jev: async () => scoreResponse(.95)
  };
  globalThis.chrome = {
    storage: {local, session: storage({})},
    runtime: {
      id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: {addListener(fn) { listener = fn; }}, onInstalled: event(), onStartup: event()
    },
    permissions: {onRemoved: event(), contains: async () => true},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}},
    tabs: {onRemoved: event(), query: async () => [{id: 1}], sendMessage: async (id, m) => { notifications.push(m); }}
  };
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({provider: 'jev', url, body, init});
    return responses.jev(body, init);
  };
  const previousSessions = {
    create: client.sessions.create, createTurnStream: client.sessions.createTurnStream, cancel: client.sessions.cancel
  };
  client.sessions.create = async () => ({data: {id: 'test-session'}});
  client.sessions.cancel = async () => {};
  client.sessions.createTurnStream = async (_id, body, options) => {
    requests.push({provider: 'trueforge', body, init: options});
    const state = await responses.trueforge(body, options);
    if (state instanceof Response && !state.ok) throw {statusCode: state.status};
    return {async *withMetadata() {yield {data: {type: 'turn.done', state}};}};
  };
  t.after(() => Object.assign(client.sessions, previousSessions));
  t.after(() => { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
  await import(`../extension/background.js?test=${++instance}`);
  const send = (message, from = sender) => {
    if (['DETECT', 'CACHE_LOOKUP'].includes(message.type)) message = {filterId: local.snapshot().filter?.id, ...message};
    return new Promise(resolve => listener(message, from, resolve));
  };
  return {send, local, requests, notifications, responses};
}

test('bulk cache lookup stays independent of API work and validates site access', async t => {
  const h = await fixture(t), {send} = h;
  assert.deepEqual(await send({type: 'CACHE_LOOKUP', texts: [passage('first')]}), {scores: [null]});
  assert.equal(h.requests.length, 0);
  assert.deepEqual(await send({type: 'DETECT', text: passage('first')}), {score: .95, source: 'api'});
  assert.deepEqual(await send({type: 'CACHE_LOOKUP', texts: [passage('first'), passage('missing'), `  ${passage('first')}  `]}), {scores: [.95, null, .95]});
  const wait = deferred(); h.responses.jev = () => wait.promise;
  const pending = send({type: 'DETECT', text: passage('slow')});
  await until(() => h.requests.length === 2);
  assert.deepEqual(await send({type: 'CACHE_LOOKUP', texts: [passage('first'), passage('slow')]}), {scores: [.95, null]});
  wait.resolve(scoreResponse(.95));
  assert.deepEqual(await pending, {score: .95, source: 'api'});
  assert.deepEqual(await send({type: 'DETECT', text: passage('first')}), {score: .95, source: 'cache'});
  assert.match((await send({type: 'CACHE_LOOKUP', texts: Array(65).fill(passage('first'))})).error, /Invalid cache lookup/);
  assert.match((await send({type: 'CACHE_LOOKUP', texts: ['']})).error, /Invalid text passage/);
  assert.match((await send({type: 'CACHE_LOOKUP', texts: [passage('first')]}, {...sender, url: 'https://disabled.example/'})).error, /Filtering is off/);
  assert.match((await send({type: 'CACHE_LOOKUP', texts: [passage('first')]}, {url: sender.url})).error, /Filtering is off/);
  assert.equal(h.requests.length, 2);
});

test('upgrade starts without a slop default; instruction compiles once and keys stay private', async t => {
  const h = await fixture(t, {filter: null});
  const before = await h.send({type: 'GET_SETTINGS'}, trusted);
  assert.equal(before.filterReady, false);
  assert.equal((await h.send({type: 'CONFIG'})).configured, false);
  assert.deepEqual(await h.send({type: 'DETECT', text: passage('unconfigured')}), {stale: true});
  const input = 'No travel content, but allow local news.';
  const saved = await h.send({type: 'SAVE_INSTRUCTION', instruction: input}, trusted);
  assert.equal(saved.ok, true); assert.match(saved.filterId, /^[a-f0-9]{64}$/);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].provider, 'trueforge');
  assert.deepEqual(h.requests[0].body.input, [{type: 'user.message', content: input}]);
  assert.ok(h.notifications.some(m => m.type === 'CONFIG_CHANGED'));
  const settings = await h.send({type: 'GET_SETTINGS'}, trusted), config = await h.send({type: 'CONFIG'});
  assert.equal(settings.filterReady, true); assert.equal(config.configured, true);
  for (const publicData of [settings, config]) assert.doesNotMatch(JSON.stringify(publicData), /jev-test-key|openai-test-key|openaiApiKey/);
  await h.send({type: 'SAVE_INSTRUCTION', instruction: `  ${input}  `}, trusted);
  assert.equal(h.requests.length, 1, 'unchanged rules do not spend another TrueForge request');
  await h.send({type: 'DETECT', text: 'Paris here we come!'});
  assert.equal(h.requests[1].provider, 'jev');
  assert.match(h.requests[1].body.questions.should_block.instructions, /allow local news/);
});

test('rule changes isolate persistent cache entries and reject old content-script requests', async t => {
  const h = await fixture(t), text = passage('same');
  await h.send({type: 'DETECT', text});
  assert.deepEqual(await h.send({type: 'CACHE_LOOKUP', texts: [text]}), {scores: [.95]});
  const oldId = h.local.snapshot().filter.id;
  await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No politics'}, trusted);
  assert.deepEqual(await h.send({type: 'DETECT', text, filterId: oldId}), {stale: true});
  assert.deepEqual(await h.send({type: 'CACHE_LOOKUP', texts: [text], filterId: oldId}), {stale: true});
  assert.deepEqual(await h.send({type: 'CACHE_LOOKUP', texts: [text]}), {scores: [null]});
  h.responses.jev = async () => scoreResponse(0);
  assert.deepEqual(await h.send({type: 'DETECT', text}), {score: 0, source: 'api'});
  assert.equal(h.local.snapshot().passageScoresV2.length, 2);
  assert.equal(h.requests.filter(r => r.provider === 'trueforge').length, 1);
});

test('compiler failure preserves the previous rule; clearing needs no OpenAI key', async t => {
  const h = await fixture(t);
  h.responses.trueforge = async () => new Response('private provider error', {status: 401});
  const failed = await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No politics'}, trusted);
  assert.match(failed.error, /TrueForge requires login/);
  assert.deepEqual(h.local.snapshot().filter, filter);
  await h.send({type: 'SAVE_SETTINGS', threshold: .85, openaiApiKey: ''}, trusted);
  assert.equal((await h.send({type: 'CONFIG'})).configured, true, 'compiled filters do not need the OpenAI key');
  assert.equal((await h.send({type: 'SAVE_INSTRUCTION', instruction: ''}, trusted)).ok, true);
  assert.equal(h.local.snapshot().filter, null);
  assert.equal((await h.send({type: 'CONFIG'})).configured, false);
  assert.equal(h.requests.length, 1);
});

test('a slow older compilation cannot replace a newer saved rule or resurrect a cleared rule', async t => {
  const h = await fixture(t), wait = deferred();
  h.responses.trueforge = body => body.input[0].content === 'Old rule' ? wait.promise : compiledResponse(body.input[0].content);
  const old = h.send({type: 'SAVE_INSTRUCTION', instruction: 'Old rule'}, trusted);
  await until(() => h.requests.length === 1);
  assert.equal((await h.send({type: 'SAVE_INSTRUCTION', instruction: 'New rule'}, trusted)).ok, true);
  wait.resolve(compiledResponse('Old rule'));
  assert.match((await old).error, /newer change/);
  assert.equal(h.local.snapshot().filter.instruction, 'New rule');
  const again = deferred(); h.responses.trueforge = () => again.promise;
  const pending = h.send({type: 'SAVE_INSTRUCTION', instruction: 'Another rule'}, trusted);
  await until(() => h.requests.length === 3);
  await h.send({type: 'SAVE_INSTRUCTION', instruction: ''}, trusted);
  again.resolve(compiledResponse('Another rule'));
  assert.match((await pending).error, /newer change/);
  assert.equal(h.local.snapshot().filter, null);
});

test('old in-flight evaluations cannot return a usable score after a rule switch', async t => {
  const h = await fixture(t), wait = deferred();
  h.responses.jev = () => wait.promise;
  const pending = h.send({type: 'DETECT', text: passage('in flight')});
  await until(() => h.requests.length === 1);
  await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No politics'}, trusted);
  wait.resolve(scoreResponse(.99));
  assert.deepEqual(await pending, {stale: true});
  assert.deepEqual(await h.send({type: 'CACHE_LOOKUP', texts: [passage('in flight')]}), {scores: [null]});
});

test('only extension pages can edit rules and keys; invalid saves do not replace settings', async t => {
  const h = await fixture(t);
  assert.match((await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No politics'})).error, /Not allowed/);
  assert.match((await h.send({type: 'GET_SETTINGS'})).error, /Not allowed/);
  assert.match((await h.send({type: 'SAVE_SETTINGS', threshold: .85, apiKey: 'bad key'}, trusted)).error, /valid API key/);
  assert.equal(h.local.snapshot().openaiApiKey, 'openai-test-key');
  assert.equal(h.requests.length, 0);
});
