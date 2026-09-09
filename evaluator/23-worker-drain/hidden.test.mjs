import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('shutdown waits and rejects new work',async()=>{
 let release;const gate=new Promise(r=>release=r);const w=api.createWorker(()=>gate);const p=w.enqueue(1);await Promise.resolve();let done=false;const close=w.shutdown().then(()=>done=true);await Promise.resolve();assert.equal(done,false);await assert.rejects(w.enqueue(2),/CLOSED/);release('ok');assert.equal(await p,'ok');await close;assert.equal(w.active(),0);await w.shutdown();
});
test('rejected tasks leave active set and retain caller failure',async()=>{const w=api.createWorker(async()=>{throw Error('job')});await assert.rejects(w.enqueue(1),/job/);await w.shutdown();assert.equal(w.active(),0);});
