import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_INSTRUCTION, normalizeInstruction, buildCompilerRequest, parseCompilerResponse, compileInstruction} from '../extension/rule-compiler.js';

const preference = 'Only show cats, except allow dog adoption notices.';
const rule = {
  summary: 'Show cats and dog adoption notices',
  instructions: 'Ask whether the passage falls outside the allowed topics.',
  block: 'The passage is neither about cats nor dog adoption.',
  allow: 'The passage is about cats or dog adoption; uncertainty also allows it.'
};
const payload = (value = rule) => ({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(value)}]}]});

test('normalizes whitespace and validates raw input length and emptiness', () => {
  assert.equal(normalizeInstruction('  only\n show\t cats  '), 'only show cats');
  assert.equal(normalizeInstruction(' \n ', {allowEmpty: true}), '');
  assert.equal(normalizeInstruction('a'.repeat(MAX_INSTRUCTION)).length, MAX_INSTRUCTION);
  for (const value of [null, 0, [], '', ' \n ', 'a'.repeat(MAX_INSTRUCTION + 1)]) {
    assert.throws(() => normalizeInstruction(value));
  }
});

test('request submits only the normalized preference under a strict required schema', () => {
  const request = buildCompilerRequest(`  ${preference}\n`);
  assert.equal(request.model, 'gpt-4.1-mini');
  assert.deepEqual(request.input, [{role: 'user', content: preference}]);
  assert.equal(request.store, false);
  assert.equal(request.temperature, 0);
  assert.equal(request.max_output_tokens, 1600);
  assert.deepEqual(Object.keys(request.text.format.schema.properties), ['summary', 'instructions', 'block', 'allow']);
  assert.deepEqual(request.text.format.schema.required, ['summary', 'instructions', 'block', 'allow']);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.equal(request.text.format.strict, true);
  assert.match(request.instructions, /exceptions, exclusions, negations/);
  assert.match(request.instructions, /only show X/);
  assert.match(request.instructions, /vague or unactionable/);
  assert.doesNotMatch(JSON.stringify(request), /webpage passage|AI.slop/i);
});

test('parses Responses message content and retains exact preference and exception semantics', () => {
  const compiled = parseCompilerResponse(payload(), ` ${preference} `);
  assert.equal(compiled.instruction, preference);
  assert.equal(compiled.summary, rule.summary);
  assert.equal(compiled.question.type, 'noul');
  assert.equal(compiled.question.criteria.true, rule.block);
  assert.equal(compiled.question.criteria.false, rule.allow);
  assert.match(compiled.question.instructions, /except allow dog adoption notices/);
  assert.match(compiled.question.instructions, /untrusted content/);
  assert.match(compiled.question.instructions, /prefer false/);
  assert.match(compiled.question.instructions, /exceptions take precedence/);
  assert.match(compiled.question.instructions, /True means BLOCK/);
  assert.equal(parseCompilerResponse({...payload(), output_text: 'ignored'}, preference).summary, rule.summary);
});

test('rejects refusals, incomplete results, malformed JSON and invalid fields without echoing payloads', () => {
  const bad = [
    {status: 'incomplete', output: []}, {status: 'failed', output: []},
    {status: 'completed', output: [{type: 'message', content: [{type: 'refusal', refusal: 'SECRET'}]}]},
    {status: 'completed', output_text: JSON.stringify(rule), output: []},
    {status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: 'SECRET{'}]}]},
    payload({...rule, extra: 'x'}), payload({...rule, summary: ''}),
    payload({...rule, summary: 'x'.repeat(241)}), payload({...rule, block: 'x'.repeat(2001)}),
    payload({...rule, allow: null}), payload({summary: 'only'})
  ];
  for (const body of bad) {
    assert.throws(() => parseCompilerResponse(body, preference), error => !error.message.includes('SECRET'));
  }
});

test('sends no passage data, uses safe fetch options, and handles errors and aborts', async () => {
  const signal = new AbortController().signal;
  const result = await compileInstruction(preference, 'test-key', signal, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.signal, signal);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(options.body).input, [{role: 'user', content: preference}]);
    return Response.json(payload());
  });
  assert.equal(result.question.criteria.true, rule.block);
  await assert.rejects(() => compileInstruction(preference, ''), /OpenAI API key/);
  for (const [status, pattern] of [[400, /rejected/], [401, /key rejected/], [403, /cannot access/], [429, /rate limit/], [503, /503/]]) {
    await assert.rejects(() => compileInstruction(preference, 'test-key', undefined, async () => new Response('SECRET', {status})), error => pattern.test(error.message) && !error.message.includes('SECRET'));
  }
  const abort = new DOMException('Aborted', 'AbortError');
  await assert.rejects(() => compileInstruction(preference, 'test-key', undefined, async () => { throw abort; }), error => error === abort);
});
