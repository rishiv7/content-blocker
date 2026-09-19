import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {RequestLog, redact, responsePreview, RESPONSE_LIMIT} from '../extension/request-log.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const store=()=>{let data={};return {get:async()=>structuredClone(data),set:async values=>{data=structuredClone(values)}}};
test('pending request updates persist across worker instances',async()=>{
 const storage=store(),log=new RequestLog(storage);
 const id=await log.start({kind:'api',state:'pending'});
 await log.update(id,{state:'success',score:.9,response:{status:200,body:'{}'}});
 const saved=(await new RequestLog(storage).snapshot()).entries[0];assert.equal(saved.score,.9);assert.equal(saved.response.status,200);
});
test('retention, pause and clear do not resurrect cleared requests',async()=>{
 const log=new RequestLog(store(),2),id=await log.start({state:'pending'});
 await log.start({state:'success'});await log.start({state:'success'});
 assert.equal((await log.snapshot()).entries.length,2);
 await log.setEnabled(false);assert.equal(await log.start({state:'pending'}),null);
 await log.clear();await log.update(id,{state:'success'});assert.equal((await log.snapshot()).entries.length,0);
});
test('concurrent logging retains every completion',async()=>{
 const log=new RequestLog(store());const ids=await Promise.all(Array.from({length:10},()=>log.start({state:'pending'})));
 await Promise.all(ids.map(id=>log.update(id,{state:'success'})));
 assert.equal((await log.snapshot()).entries.filter(x=>x.state==='success').length,10);
});
test('key redaction handles nested strings and unusual characters',()=>{
 const secret='test-"key\\123';const result=redact({passage:secret,response:{body:`echo ${secret}`},score:0},secret);
 assert.equal(result.passage,'[REDACTED]');assert.equal(result.response.body,'echo [REDACTED]');assert.equal(result.score,0);
});
test('preview captures and bounds responses without consuming original',async()=>{
 const response=Response.json({answers:{is_slop:{type:'noul',noul:.9}}});
 const preview=await responsePreview(response);assert.equal(preview.truncated,false);assert.deepEqual(JSON.parse(preview.body),await response.json());
 const large=new Response('x'.repeat(RESPONSE_LIMIT+100));const limited=await responsePreview(large);
 assert.equal(limited.truncated,true);assert.equal(limited.body.length,RESPONSE_LIMIT);assert.equal((await large.text()).length,RESPONSE_LIMIT+100);
});
