import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('out of order refresh never overwrites newer state',async()=>{const waits=[];const s=api.createSettings(()=>new Promise((resolve,reject)=>waits.push({resolve,reject})));const a=s.refresh('x'),b=s.refresh('x');waits[1].resolve('new');assert.equal(await b,'new');waits[0].resolve('old');assert.equal(await a,'old');assert.equal(s.get('x'),'new');const c=s.refresh('x');s.set('x','manual');waits[2].resolve('pending');await c;assert.equal(s.get('x'),'manual');});
test('keys independent and latest failure suppresses older completion',async()=>{const waits=[];const s=api.createSettings(()=>new Promise((resolve,reject)=>waits.push({resolve,reject})));s.set('other',1);s.set('other',2);const x=s.refresh('x');waits[0].resolve('ok');await x;assert.equal(s.get('x'),'ok');const a=s.refresh('x'),b=s.refresh('x');waits[2].reject(Error('wire'));await assert.rejects(b,/wire/);waits[1].resolve('stale');await a;assert.equal(s.get('x'),'ok');});
