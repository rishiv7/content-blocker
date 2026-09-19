import test from 'node:test';
import assert from 'node:assert/strict';
import {TrueForge} from '../extension/vendor/trueforge-sdk.js';
import {compileInstruction, normalizeInstruction, parseCompilerResponse} from '../extension/rule-compiler.js';
import {buildRequest} from '../extension/jev.js';

const fields = {summary: 'Block travel except local news.', instructions: 'Allow local news even when about travel.', block: 'Travel that is not local news.', allow: 'Local news, including travel; non-travel and ambiguous text.'};
const state = (output = {}) => ({status: 'done', requiredActions: [], output: {type: 'model.message', threadId: 'main', finishReason: 'stop', content: JSON.stringify(fields), ...output}});
const fake = (events) => ({sessions: {create: async () => ({data: {id: 'session-1'}}), createTurnStream: async () => ({async *withMetadata() {for (const data of events) yield {data};}}), cancel: async () => {}}});

test('validates strict fields and produces a Jev-compatible question with original preference', () => {
  const result = parseCompilerResponse(state(), ' No travel,  except local news. ');
  assert.equal(result.instruction, 'No travel, except local news.');
  assert.equal(buildRequest('A local airport update.', result.question).questions.should_block.criteria.false, fields.allow);
  assert.match(result.question.instructions, /Explicit user exceptions take precedence/);
});

test('rejects malformed, extra, empty and oversized fields', () => {
  for (const content of ['{', '[]', JSON.stringify({...fields, extra: true}), JSON.stringify({...fields, allow: ''}), JSON.stringify({...fields, summary: 'x'.repeat(241)}), JSON.stringify({...fields, block: 'x'.repeat(2001)})]) {
    assert.throws(() => parseCompilerResponse(state({content}), 'No travel'), /invalid/);
  }
  for (const input of ['', null, 'x'.repeat(2001)]) assert.throws(() => normalizeInstruction(input));
});

test('rejects partial, refused, paused, cancelled and non-root model output', () => {
  for (const value of [state({finishReason: 'length'}), state({refusal: 'No'}), state({content: [{type: 'refusal', refusal: 'No'}]}), state({threadId: 'child'}), {...state(), requiredActions: [{}]}, {status: 'cancelled'}, {status: 'error'}]) {
    assert.throws(() => parseCompilerResponse(value, 'No travel'));
  }
});

test('accepts structured content parts and waits for terminal output, ignoring deltas', async () => {
  const result = await compileInstruction('No travel', undefined, fake([
    {type: 'model.message.delta', content: '{bad partial'},
    {type: 'turn.done', state: state({content: [{type: 'text', text: JSON.stringify(fields)}]})}
  ]));
  assert.equal(result.summary, fields.summary);
});

test('cancels server work when stream ends without terminal result', async () => {
  const sdk = fake([]); let cancelled;
  sdk.sessions.cancel = async id => {cancelled = id;};
  await assert.rejects(compileInstruction('No travel', undefined, sdk), /disconnected/);
  assert.equal(cancelled, 'session-1');
});

test('abort reaches SDK and cancels the server-side turn', async () => {
  const controller = new AbortController(); const sdk = fake([]); let cancelled = false;
  sdk.sessions.createTurnStream = async (id, request, options) => {
    assert.equal(options.abortSignal, controller.signal);
    controller.abort(); throw new DOMException('Aborted', 'AbortError');
  };
  sdk.sessions.cancel = async () => {cancelled = true;};
  await assert.rejects(compileInstruction('No travel', controller.signal, sdk), {name: 'AbortError'});
  assert.equal(cancelled, true);
});

test('pre-aborted instructions never create a session', async () => {
  const sdk = fake([]); sdk.sessions.create = () => assert.fail('unexpected session');
  await assert.rejects(compileInstruction('No travel', AbortSignal.abort(), sdk), {name: 'AbortError'});
});

test('offline and missing agent errors are actionable', async () => {
  for (const [error, message] of [[new TypeError('fetch failed'), /Start it/], [{statusCode: 404}, /setup:trueforge/]]) {
    const sdk = fake([]); sdk.sessions.create = async () => {throw error;};
    await assert.rejects(compileInstruction('No travel', undefined, sdk), message);
  }
});

test('bundled SDK sends actual session/SSE wire requests to local TrueForge with no provider key', async () => {
  const calls = [];
  const sdk = new TrueForge({baseUrl: 'http://localhost:8790', maxRetries: 0, fetch: async (url, init) => {
    calls.push({url: String(url), init});
    if (String(url).endsWith('/turns')) {
      const payload = {type: 'turn.done', id: 'e1', thread_id: 'main', turn_id: 't1', created_at: new Date().toISOString(), state: {
        status: 'done', required_actions: [], completed_at: new Date().toISOString(), output: {
          type: 'model.message', id: 'm1', thread_id: 'main', created_at: new Date().toISOString(),
          finish_reason: 'stop', content: JSON.stringify(fields)
        }
      }};
      return new Response(`event: turn.done\nid: 1\ndata: ${JSON.stringify(payload)}\n\n`, {headers: {'Content-Type': 'text/event-stream'}});
    }
    return Response.json({data: {id: 's1'}});
  }});
  const result = await compileInstruction('No travel', undefined, sdk);
  assert.equal(result.summary, fields.summary);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://localhost:8790/api/v1/sessions');
  assert.deepEqual(JSON.parse(calls[0].init.body).agent, {name: 'content-blocker-compiler'});
  assert.deepEqual(JSON.parse(calls[1].init.body).input, [{type: 'user.message', content: 'No travel'}]);
  assert.equal(JSON.parse(calls[1].init.body).stream, true);
  for (const {init} of calls) assert.equal(new Headers(init.headers).has('Authorization'), false);
});
