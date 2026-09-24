import test from 'node:test';
import assert from 'node:assert/strict';
import {compileInstruction, normalizeInstruction, parseCompilerResponse, buildCompilerRequest, COMPILER_VERSION} from '../extension/rule-compiler.js';
import {buildRequest} from '../extension/jev.js';

const fields = {summary: 'Block travel except local news.', instructions: 'Allow local news even when about travel.', block: 'Travel that is not local news.', allow: 'Local news, including travel; non-travel and ambiguous text.'};
const outputText = (text = JSON.stringify(fields)) => [{type: 'message', content: [{type: 'output_text', text}]}];
const completed = (output = outputText()) => ({id: 'resp_1', status: 'completed', output});

test('compiler requests target gpt-6-luna on the Responses API with strict JSON output', () => {
  const request = buildCompilerRequest(' No travel,  except local news. ');
  assert.equal(request.model, 'gpt-6-luna');
  assert.match(request.instructions, /Explicit allow exceptions ALWAYS win over block topics/);
  assert.deepEqual(request.input, [{role: 'user', content: 'No travel, except local news.'}]);
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 1600);
  assert.equal(request.temperature, 0);
  assert.deepEqual(request.reasoning, {effort: 'none'});
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.name, 'blocking_rule');
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.text.format.schema.required, ['summary', 'instructions', 'block', 'allow']);
  assert.equal(request.text.format.schema.additionalProperties, false);
});

test('version marker identifies the direct OpenAI compiler', () => {
  assert.equal(COMPILER_VERSION, 'direct-openai-v1');
});

test('validates strict fields and produces a Jev-compatible question with original preference', () => {
  const result = parseCompilerResponse(completed(), ' No travel,  except local news. ');
  assert.equal(result.instruction, 'No travel, except local news.');
  assert.equal(buildRequest('A local airport update.', result.question).questions.should_block.criteria.false, fields.allow);
  assert.match(result.question.instructions, /Explicit user exceptions take precedence/);
});

test('rejects malformed, extra, empty and oversized fields', () => {
  for (const text of ['{', '[]', JSON.stringify({...fields, extra: true}), JSON.stringify({...fields, allow: ''}), JSON.stringify({...fields, summary: 'x'.repeat(241)}), JSON.stringify({...fields, block: 'x'.repeat(2001)})]) {
    assert.throws(() => parseCompilerResponse(completed(outputText(text)), 'No travel'), /invalid/);
  }
  for (const input of ['', null, 'x'.repeat(2001)]) assert.throws(() => normalizeInstruction(input));
});

test('rejects incomplete responses, refusals, and non-text message content', () => {
  for (const body of [{status: 'in_progress', output: []}, {status: 'failed', output: []}, {output: 'not-an-array'},
    completed([{type: 'message', content: [{type: 'refusal', refusal: 'No'}]}]),
    completed([{type: 'message', content: 'string content'}]),
    completed([{type: 'reasoning', content: []}]),
    completed(outputText('{"summary": "one"}'))]) {
    assert.throws(() => parseCompilerResponse(body, 'No travel'));
  }
});

test('compileInstruction sends the Bearer key and gpt-6-luna body to the real endpoint', async t => {
  const previousFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({url: String(url), init, body: JSON.parse(init.body)});
    return Response.json(completed());
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const result = await compileInstruction('No travel', 'sk-test-key');
  assert.equal(result.summary, fields.summary);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(new Headers(calls[0].init.headers).get('Content-Type'), 'application/json');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].body.model, 'gpt-6-luna');
  assert.deepEqual(calls[0].body.reasoning, {effort: 'none'});
  assert.equal(calls[0].body.text.format.name, 'blocking_rule');
});

test('saving without a key is blocked with the popup message before any request', async t => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('no request without a key');
  t.after(() => { globalThis.fetch = previousFetch; });
  for (const key of [undefined, '', '   ']) {
    await assert.rejects(compileInstruction('No travel', key), /Add an OpenAI API key in Settings to save a new filter\./);
  }
});

test('HTTP errors map to key help, rate limit, and generic messages', async t => {
  const previousFetch = globalThis.fetch;
  const status = code => { globalThis.fetch = async () => new Response('provider error', {status: code}); };
  t.after(() => { globalThis.fetch = previousFetch; });
  status(401);
  await assert.rejects(compileInstruction('No travel', 'sk-test-key'), {message: 'OpenAI API key rejected. Update it in Settings.'});
  status(403);
  await assert.rejects(compileInstruction('No travel', 'sk-test-key'), {message: 'Your OpenAI API key cannot access this model.'});
  status(429);
  await assert.rejects(compileInstruction('No travel', 'sk-test-key'), {message: 'OpenAI rate limit reached. Wait a moment and try again.'});
  status(500);
  await assert.rejects(compileInstruction('No travel', 'sk-test-key'), {message: 'OpenAI compiler unavailable (HTTP 500). Try again later.'});
});

test('a pre-aborted signal never reaches the network', async t => {
  const previousFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json(completed()); };
  t.after(() => { globalThis.fetch = previousFetch; });
  await assert.rejects(compileInstruction('No travel', 'sk-test-key', {signal: AbortSignal.abort()}), {name: 'AbortError'});
  assert.equal(called, false);
});

test('aborting mid-request rejects the pending compile', async t => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = (url, init) => new Promise((done, stop) => {
    init.signal.addEventListener('abort', () => stop(new DOMException('Aborted', 'AbortError')));
  });
  t.after(() => { globalThis.fetch = previousFetch; });
  const pending = compileInstruction('No travel', 'sk-test-key', {signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
});
