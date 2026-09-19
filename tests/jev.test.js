import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest, parseResponse, detect, ENDPOINT} from '../extension/jev.js';
const passage = 'This passage describes a concrete bus route, its departure time, the ticket price, and how to get to the station.';
test('one passage and one slop question per request',()=>{
 const request=buildRequest(passage);
 assert.equal(request.state,passage);assert.equal(request.model,'jev-latest');
 assert.deepEqual(Object.keys(request.questions),['is_slop']);
 assert.equal(request.questions.is_slop.type,'noul');
 assert.doesNotMatch(request.questions.is_slop.instructions,/whose id/);
});
test('validates passage length and normalizes whitespace',()=>{
 for(const value of [null,[passage],'short','x'.repeat(4001)]) assert.throws(()=>buildRequest(value));
 assert.equal(buildRequest(` ${passage.replaceAll(' ','\n')} `).state,passage);
});
test('validates probability boundaries and rejects malformed responses',()=>{
 for(const score of [0,.85,1]) assert.equal(parseResponse({answers:{is_slop:{type:'noul',noul:score}}}),score);
 for(const score of [null,'0.9',NaN,-1,2]) assert.throws(()=>parseResponse({answers:{is_slop:{type:'noul',noul:score}}}));
 assert.throws(()=>parseResponse({answers:{}}));
});
test('uses fixed endpoint, bearer auth, no cookies or redirects',async()=>{
 const score=await detect(passage,'test-placeholder',undefined,async(url,init)=>{
  assert.equal(url,ENDPOINT);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
  assert.equal(init.headers.Authorization,'Bearer test-placeholder');assert.equal(JSON.parse(init.body).state,passage);
  return Response.json({answers:{is_slop:{type:'noul',noul:.9}}});
 });assert.equal(score,.9);
});
test('reports authentication, rate limiting, and server errors',async()=>{
 await assert.rejects(()=>detect(passage,''),/API key/);
 for(const [status,pattern] of [[401,/rejected/],[403,/access/],[429,/rate limit/],[503,/503/]])
  await assert.rejects(()=>detect(passage,'test-placeholder',undefined,async()=>new Response('{}',{status})),pattern);
});
