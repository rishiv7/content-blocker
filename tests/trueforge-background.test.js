import test from 'node:test';
import assert from 'node:assert/strict';
import {client} from '../extension/rule-compiler.js';
import {COMPILER_VERSION} from '../extension/compiler-agent.js';

let listener, data = {};
const event = {addListener() {}};
const storage = {
  setAccessLevel: async () => {},
  get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => Object.hasOwn(data, k)).map(k => [k, structuredClone(data[k])])),
  set: async values => {Object.assign(data, structuredClone(values));}
};
globalThis.chrome = {
  storage: {local: storage, session: storage},
  runtime: {id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: {addListener(fn) {listener = fn;}}, onInstalled: event, onStartup: event},
  scripting: {getRegisteredContentScripts: async () => []},
  permissions: {contains: async () => true, onRemoved: event},
  tabs: {query: async () => [], onRemoved: event}
};
await import('../extension/background.js');
const send = (message, sender = {id: 'test', url: 'chrome-extension://test/popup.html'}) => new Promise(resolve => listener(message, sender, resolve));
const payload = {summary: 'Block travel.', instructions: 'Judge only travel text.', block: 'Travel.', allow: 'Other text.'};
let count = 0;
function reset() {
  data = {apiKey: 'typesafe-test', openaiApiKey: 'legacy-key', sites: [], threshold: 0.85}; count = 0;
  client.sessions.create = async () => {count++; return {data: {id: 's1'}};};
  client.sessions.createTurnStream = async () => ({async *withMetadata() {yield {data: {type: 'turn.done', state: {status: 'done', requiredActions: [], output: {type: 'model.message', threadId: 'main', finishReason: 'stop', content: JSON.stringify(payload)}}}};}});
  client.sessions.cancel = async () => {};
}

test('saving uses TrueForge without an extension OpenAI key and reuses unchanged rules', async () => {
  reset(); delete data.openaiApiKey;
  assert.equal((await send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'})).ok, true);
  assert.equal(data.filter.compilerVersion, COMPILER_VERSION);
  assert.match(data.filter.id, /^[a-f0-9]{64}$/);
  assert.equal((await send({type: 'SAVE_INSTRUCTION', instruction: 'No   travel'})).ok, true);
  assert.equal(count, 1);
  const settings = await send({type: 'GET_SETTINGS'});
  assert.equal(settings.compilerAgent, 'content-blocker-compiler');
  assert.equal('apiKey' in settings, false);
  assert.equal('openaiApiKey' in settings, false);
});

test('existing OpenAI-compiled rules work until saved, then upgrade through TrueForge', async () => {
  reset(); await send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'});
  delete data.filter.compilerVersion;
  await send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'});
  assert.equal(count, 2);
  assert.equal(data.filter.compilerVersion, COMPILER_VERSION);
});

test('malformed or unavailable compiler leaves the previous rule active', async () => {
  reset(); await send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'});
  const saved = structuredClone(data.filter);
  client.sessions.createTurnStream = async () => ({async *withMetadata() {yield {data: {type: 'turn.done', state: {status: 'done', output: {type: 'model.message', threadId: 'main', content: 'invalid'}}}};}});
  assert.match((await send({type: 'SAVE_INSTRUCTION', instruction: 'Only cats'})).error, /invalid/);
  assert.deepEqual(data.filter, saved);
  client.sessions.create = async () => {throw new TypeError('Offline');};
  assert.match((await send({type: 'SAVE_INSTRUCTION', instruction: 'Only cats'})).error, /Start it/);
  assert.deepEqual(data.filter, saved);
});

test('clear wins over delayed compilation and cancels server work', async () => {
  reset(); let release, started, cancelled = false;
  const entered = new Promise(resolve => {started = resolve;});
  client.sessions.createTurnStream = async () => {
    started(); await new Promise(resolve => {release = resolve;});
    return {async *withMetadata() {yield {data: {type: 'turn.done', state: {status: 'done'}}};}};
  };
  client.sessions.cancel = async () => {cancelled = true;};
  const pending = send({type: 'SAVE_INSTRUCTION', instruction: 'No travel'});
  await entered;
  assert.equal((await send({type: 'SAVE_INSTRUCTION', instruction: ''})).ok, true);
  release(); assert.match((await pending).error, /newer change/);
  assert.equal(data.filter, null); assert.equal(cancelled, true);
});

test('content scripts cannot save instructions or call the compiler readiness probe', async () => {
  reset();
  for (const type of ['SAVE_INSTRUCTION', 'TEST_COMPILER', 'SAVE_SETTINGS']) {
    assert.equal((await send({type, instruction: 'No travel'}, {id: 'test', url: 'https://example.com', tab: {id: 1}})).error, 'Not allowed.');
  }
  assert.equal(count, 0);
});
