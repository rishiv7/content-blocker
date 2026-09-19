import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ScoreCache} from '../extension/score-cache.js';
const key = value => createHash('sha256').update(value).digest('hex');
const store = () => {let data={};return {get:async()=>structuredClone(data),set:async value=>{data=structuredClone({...data,...value})}}};
const never=()=>{throw new Error('Unexpected duplicate evaluation')};
test('scores including zero survive cache recreation',async()=>{
 const storage=store(),cache=new ScoreCache(storage);
 await cache.getOrCompute(key('same'),async()=>0);
 assert.equal(await new ScoreCache(storage).getOrCompute(key('same'),never),0);
});
test('concurrent requests share one computation and report their source',async()=>{
 const cache=new ScoreCache(store());let calls=0;const sources=[];
 const results=await Promise.all(Array.from({length:10},()=>cache.getOrCompute(key('same'),async()=>{
  calls++;await new Promise(r=>setTimeout(r,10));return .9;
 },source=>sources.push(source))));
 assert.deepEqual(results,Array(10).fill(.9));assert.equal(calls,1);
 assert.equal(sources.filter(x=>x==='api').length,1);assert.equal(sources.filter(x=>x==='shared').length,9);
 await cache.getOrCompute(key('same'),never,source=>assert.equal(source,'cache'));
});
test('errors and invalid results are not cached',async()=>{
 const cache=new ScoreCache(store());
 await assert.rejects(()=>cache.getOrCompute(key('retry'),async()=>{throw new Error('offline')}));
 await assert.rejects(()=>cache.getOrCompute(key('retry'),async()=>NaN));
 assert.equal(await cache.getOrCompute(key('retry'),async()=>.4),.4);
});
test('simultaneous writes retain every score on restart',async()=>{
 const storage=store(),cache=new ScoreCache(storage);
 await Promise.all(Array.from({length:10},(_,i)=>cache.getOrCompute(key(String(i)),async()=>i/10)));
 const fresh=new ScoreCache(storage);
 for(let i=0;i<10;i++)assert.equal(await fresh.getOrCompute(key(String(i)),never),i/10);
});
test('bounded cache retains recently read entries',async()=>{
 const cache=new ScoreCache(store(),2);
 await cache.getOrCompute(key('a'),async()=>.1);await cache.getOrCompute(key('b'),async()=>.2);
 await cache.getOrCompute(key('a'),never);await cache.getOrCompute(key('c'),async()=>.3);
 assert.equal(cache.entries.has(key('b')),false);assert.equal(cache.entries.size,2);
});
test('bulk probes preserve order and zero scores without computing misses',async()=>{
 const storage=store(),cache=new ScoreCache(storage);
 await cache.getOrCompute(key('zero'),async()=>0);
 await cache.getOrCompute(key('high'),async()=>.95);
 const fresh=new ScoreCache(storage);
 assert.deepEqual(await fresh.getMany([key('high'),key('missing'),key('zero'),key('high')]),[.95,null,0,.95]);
 assert.equal(fresh.entries.size,2);
 assert.equal(fresh.pending.size,0);
});
test('bulk probes do not wait for pending evaluations and refresh recency',async()=>{
 const cache=new ScoreCache(store(),2);
 await cache.getOrCompute(key('a'),async()=>.1);
 await cache.getOrCompute(key('b'),async()=>.2);
 let finish;
 const pending=cache.getOrCompute(key('c'),()=>new Promise(resolve=>{finish=resolve}));
 assert.deepEqual(await cache.getMany([key('c'),key('a')]),[null,.1]);
 await Promise.resolve();
 finish(.3);await pending;
 assert.deepEqual(await cache.getMany([key('a'),key('b'),key('c')]),[.1,null,.3]);
});
