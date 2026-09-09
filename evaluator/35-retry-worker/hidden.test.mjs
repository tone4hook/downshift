import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('backoff and exact call budget',async()=>{const delays=[],attempts=[];const error=Object.assign(Error('wire'),{retryable:true});let calls=0;await assert.rejects(api.deliver(async()=>{calls++;if(calls>4)throw Error('too many');throw error},async d=>delays.push(d),a=>attempts.push(a),3,10),e=>e===error);assert.equal(calls,3);assert.deepEqual(delays,[10,20]);assert.deepEqual(attempts,[1,2,3]);});
test('no sleep on permanent failure or success, invalid budget before send',async()=>{let calls=0;let sleeps=0;const error=Error('permanent');await assert.rejects(api.deliver(async()=>{calls++;throw error},async()=>sleeps++,()=>{},3,0),e=>e===error);assert.equal(calls,1);assert.equal(sleeps,0);assert.equal(await api.deliver(async()=>7,async()=>sleeps++,()=>{},2,1),7);for(const max of [0,-1,1.5])await assert.rejects(api.deliver(async()=>calls++,async()=>{},()=>{},max,1),/INVALID_RETRY/);assert.equal(calls,1);});
