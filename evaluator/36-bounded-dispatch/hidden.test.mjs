import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('bounded activity and ordered all-settled results',async()=>{let active=0,max=0;const waits=[];const error=Error('job');const pending=api.dispatch([0,1,2],i=>{active++;max=Math.max(max,active);return new Promise((resolve,reject)=>{waits[i]={resolve:v=>{active--;resolve(v)},reject:e=>{active--;reject(e)}}})},2);assert.equal(waits.length,2);waits[1].reject(error);await Promise.resolve();await Promise.resolve();waits[2].resolve('two');waits[0].resolve('zero');assert.deepEqual(await pending,[{status:'fulfilled',value:'zero'},{status:'rejected',reason:error},{status:'fulfilled',value:'two'}]);assert.equal(max,2);});
test('invalid concurrency before execution and empty batch',async()=>{let calls=0;for(const c of [0,-1,1.5,NaN])await assert.rejects(api.dispatch([1],()=>calls++,c),/INVALID_CONCURRENCY/);assert.equal(calls,0);assert.deepEqual(await api.dispatch([],()=>calls++,2),[]);});
