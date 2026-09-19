import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest, parseResponse, detect, ENDPOINT} from '../extension/jev.js';
const passage = 'This passage describes a concrete bus route, its departure time, the ticket price, and how to get to the station.';
const question = {type: 'noul', instructions: 'Should this passage be blocked for discussing travel?',
  criteria: {true: 'The passage discusses travel.', false: 'The passage does not discuss travel.'}};

test('one passage and the compiled blocking question per request, with no slop fallback', () => {
  const request = buildRequest(passage, question);
  assert.equal(request.state, passage); assert.equal(request.model, 'jev-latest');
  assert.deepEqual(Object.keys(request.questions), ['should_block']);
  assert.deepEqual(request.questions.should_block, question);
  assert.throws(() => buildRequest(passage), /blocking instruction/);
  assert.throws(() => buildRequest(passage, {...question, criteria: {true: ''}}), /blocking instruction/);
  const other = {...question, instructions: 'Block politics instead of travel.'};
  assert.notEqual(JSON.stringify(buildRequest(passage, question)), JSON.stringify(buildRequest(passage, other)));
});
test('validates passage length, accepts short content, and normalizes whitespace', () => {
  for (const value of [null, [passage], '', ' \n ', 'x'.repeat(4001)]) assert.throws(() => buildRequest(value, question));
  assert.equal(buildRequest(` ${passage.replaceAll(' ', '\n')} `, question).state, passage);
  assert.equal(buildRequest('Paris here we come!', question).state, 'Paris here we come!');
});
test('validates probability boundaries and rejects malformed or old-rubric responses', () => {
  for (const score of [0, .85, 1]) assert.equal(parseResponse({answers: {should_block: {type: 'noul', noul: score}}}), score);
  for (const score of [null, '0.9', NaN, -1, 2]) assert.throws(() => parseResponse({answers: {should_block: {type: 'noul', noul: score}}}));
  assert.throws(() => parseResponse({answers: {is_slop: {type: 'noul', noul: .95}}}));
  assert.throws(() => parseResponse({answers: {}}));
});
test('uses fixed endpoint, bearer auth, supplied rule, no cookies or redirects', async () => {
  const score = await detect(passage, question, 'test-placeholder', undefined, async (url, init) => {
    assert.equal(url, ENDPOINT); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer test-placeholder');
    assert.deepEqual(JSON.parse(init.body), buildRequest(passage, question));
    return Response.json({answers: {should_block: {type: 'noul', noul: .9}}});
  });
  assert.equal(score, .9);
});
test('reports authentication, rate limiting, and server errors', async () => {
  await assert.rejects(() => detect(passage, question, ''), /API key/);
  for (const [status, pattern] of [[401, /rejected/], [403, /access/], [429, /rate limit/], [503, /503/]])
    await assert.rejects(() => detect(passage, question, 'test-placeholder', undefined, async () => new Response('{}', {status})), pattern);
});
