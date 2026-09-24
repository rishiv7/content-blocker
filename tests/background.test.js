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
const passage = suffix => `This is a sufficiently long passage containing specific details about the library opening hours and book returns. ${suffix}`;
const sender = {id: 'test-extension', tab: {id: 1}, documentId: 'document', url: 'https://example.com/feed'};
const trusted = {id: 'test-extension', url: 'chrome-extension://test-extension/popup.html'};
const filter = {id: 'a'.repeat(64), instruction: 'No travel content', summary: 'Hide travel',
  question: {type: 'noul', instructions: 'Block travel content.', criteria: {true: 'Discusses travel', false: 'Unrelated to travel'}}};
const compiledRule = instruction => ({summary: instruction, instructions: `Does the passage violate this preference: ${instruction}?`,
  block: `Violates ${instruction}`, allow: `Does not violate ${instruction} or matches an exception.`});
// Direct OpenAI Responses API shape: one completed response with a single output_text part.
const compiledResponse = instruction => ({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(compiledRule(instruction))}]}]});
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
    openai: async body => Response.json(compiledResponse(body.input[0].content)), jev: async () => scoreResponse(.95)
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
    if (String(url).startsWith('https://api.openai.com/')) {
      requests.push({provider: 'openai', url: String(url), body, init});
      return responses.openai(body, init);
    }
    requests.push({provider: 'jev', url: String(url), body, init});
    return responses.jev(body, init);
  };
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

test('saving compiles on gpt-6-luna with the saved key and reuses unchanged rules', async t => {
  const h = await fixture(t, {filter: null});
  const before = await h.send({type: 'GET_SETTINGS'}, trusted);
  assert.equal(before.filterReady, false);
  assert.equal(before.openaiConfigured, true);
  assert.equal((await h.send({type: 'CONFIG'})).configured, false);
  assert.deepEqual(await h.send({type: 'DETECT', text: passage('unconfigured')}), {stale: true});
  const input = 'No travel content, but allow local news.';
  const saved = await h.send({type: 'SAVE_INSTRUCTION', instruction: input}, trusted);
  assert.equal(saved.ok, true); assert.match(saved.filterId, /^[a-f0-9]{64}$/);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].provider, 'openai');
  assert.equal(h.requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer openai-test-key');
  assert.equal(h.requests[0].body.model, 'gpt-6-luna');
  assert.deepEqual(h.requests[0].body.reasoning, {effort: 'none'});
  assert.deepEqual(h.requests[0].body.input, [{role: 'user', content: input}]);
  assert.equal(h.requests[0].body.text.format.name, 'blocking_rule');
  assert.ok(h.notifications.some(m => m.type === 'CONFIG_CHANGED'));
  const settings = await h.send({type: 'GET_SETTINGS'}, trusted), config = await h.send({type: 'CONFIG'});
  assert.equal(settings.filterReady, true); assert.equal(config.configured, true);
  for (const publicData of [settings, config]) assert.doesNotMatch(JSON.stringify(publicData), /jev-test-key|openai-test-key|openaiApiKey/);
  await h.send({type: 'SAVE_INSTRUCTION', instruction: `  ${input}  `}, trusted);
  assert.equal(h.requests.length, 1, 'unchanged rules do not spend another OpenAI request');
  await h.send({type: 'DETECT', text: 'Paris here we come!'});
  assert.equal(h.requests[1].provider, 'jev');
  assert.match(h.requests[1].body.questions.should_block.instructions, /allow local news/);
});

test('a legacy saved OpenAI key still loads, compiles, and stays private', async t => {
  const h = await fixture(t, {filter: null, openaiApiKey: 'legacy-key'});
  const settings = await h.send({type: 'GET_SETTINGS'}, trusted);
  assert.equal(settings.openaiConfigured, true);
  const saved = await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'}, trusted);
  assert.equal(saved.ok, true);
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer legacy-key');
  assert.doesNotMatch(JSON.stringify(settings), /legacy-key|openaiApiKey/);
});

test('saving without a key is blocked with the popup message and touches no API', async t => {
  const h = await fixture(t, {filter: null, openaiApiKey: ''});
  const result = await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'}, trusted);
  assert.match(result.error, /Add an OpenAI API key in Settings to save a new filter\./);
  assert.equal(h.requests.length, 0);
  assert.equal(h.local.snapshot().filter, null);
});

test('changing the OpenAI key cancels an in-flight compile', async t => {
  const h = await fixture(t, {filter: null}), wait = deferred();
  h.responses.openai = () => wait.promise;
  const pending = h.send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'}, trusted);
  await until(() => h.requests.length === 1);
  await h.send({type: 'SAVE_SETTINGS', threshold: .85, openaiApiKey: 'openai-test-key-2'}, trusted);
  wait.resolve(Response.json(compiledResponse('No travel')));
  assert.match((await pending).error, /newer change/);
});

test('filters compiled by an older compiler version recompile on the next save', async t => {
  const h = await fixture(t, {filter: null});
  const openaiCalls = () => h.requests.filter(r => r.provider === 'openai').length;
  await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'}, trusted);
  assert.equal(openaiCalls(), 1);
  await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'}, trusted);
  assert.equal(openaiCalls(), 1, 'the same compiler version reuses the saved rule');
  await h.local.set({filter: {...compiledRule('No travel'), id: 'b'.repeat(64), instruction: 'No travel',
    question: filter.question, compilerVersion: 'trueforge-v1'}});
  await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'}, trusted);
  assert.equal(openaiCalls(), 2, 'a different compiler version forces a recompile');
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
  assert.equal(h.requests.filter(r => r.provider === 'openai').length, 1);
});

test('compiler failure preserves the previous rule; clearing needs no OpenAI key', async t => {
  const h = await fixture(t);
  h.responses.openai = async () => new Response('private provider error', {status: 401});
  const failed = await h.send({type: 'SAVE_INSTRUCTION', instruction: 'No politics'}, trusted);
  assert.match(failed.error, /API key rejected/);
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
  h.responses.openai = body => body.input[0].content === 'Old rule' ? wait.promise : Response.json(compiledResponse(body.input[0].content));
  const old = h.send({type: 'SAVE_INSTRUCTION', instruction: 'Old rule'}, trusted);
  await until(() => h.requests.length === 1);
  assert.equal((await h.send({type: 'SAVE_INSTRUCTION', instruction: 'New rule'}, trusted)).ok, true);
  wait.resolve(Response.json(compiledResponse('Old rule')));
  assert.match((await old).error, /newer change/);
  assert.equal(h.local.snapshot().filter.instruction, 'New rule');
  const again = deferred(); h.responses.openai = () => again.promise;
  const pending = h.send({type: 'SAVE_INSTRUCTION', instruction: 'Another rule'}, trusted);
  await until(() => h.requests.length === 3);
  await h.send({type: 'SAVE_INSTRUCTION', instruction: ''}, trusted);
  again.resolve(Response.json(compiledResponse('Another rule')));
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
  assert.match((await h.send({type: 'SAVE_SETTINGS', threshold: .85}, {id: 'test', url: 'https://example.com', tab: {id: 1}})).error, /Not allowed/);
  assert.match((await h.send({type: 'SAVE_SETTINGS', threshold: .85, apiKey: 'bad key'}, trusted)).error, /valid API key/);
  assert.match((await h.send({type: 'SAVE_SETTINGS', threshold: .85, openaiApiKey: 'bad key'}, trusted)).error, /valid API key/);
  assert.equal(h.local.snapshot().openaiApiKey, 'openai-test-key');
  assert.equal(h.requests.length, 0);
});
