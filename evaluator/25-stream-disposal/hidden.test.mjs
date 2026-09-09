import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('ordered values and one unsubscribe',async()=>{let emit;let calls=0;const s=api.subscribeStream({subscribe(fn){emit=fn;return ()=>calls++;}});emit(1);emit(2);assert.deepEqual(await s.next(),{value:1,done:false});assert.deepEqual(await s.next(),{value:2,done:false});s.dispose();s.dispose();emit(3);assert.deepEqual(await s.next(),{done:true});assert.equal(calls,1);});
test('disposal settles pending reads even when unsubscribe throws',async()=>{const s=api.subscribeStream({subscribe(){return ()=>{throw Error('unsubscribe')}}});const next=s.next();assert.throws(()=>s.dispose(),/unsubscribe/);assert.deepEqual(await next,{done:true});});
test('ended queues discard late pushes',async()=>{const q=api.createQueue();q.end();q.push(1);assert.deepEqual(await q.next(),{done:true});});
