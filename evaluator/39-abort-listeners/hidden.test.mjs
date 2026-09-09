import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
function signal(reason){const listeners=new Set();return {aborted:false,reason,addEventListener(_,fn){listeners.add(fn)},removeEventListener(_,fn){listeners.delete(fn)},abort(){this.aborted=true;for(const fn of [...listeners])fn()},count:()=>listeners.size};}
test('completion and abort clean listeners',async()=>{let tick;let cancels=0;const s=signal(0);const p=api.sleepWithSignal(fn=>{tick=fn;return 7},id=>{assert.equal(id,7);cancels++},s);s.abort();await assert.rejects(p,e=>e===0);tick();assert.equal(cancels,1);assert.equal(s.count(),0);const s2=signal('why');const p2=api.sleepWithSignal(fn=>{tick=fn;return 8},()=>cancels++,s2);tick();await p2;assert.equal(s2.count(),0);s2.abort();assert.equal(cancels,1);});
test('preaborted schedules nothing',async()=>{const s=signal('stopped');s.aborted=true;let scheduled=0;await assert.rejects(api.sleepWithSignal(()=>scheduled++,()=>{},s),e=>e==='stopped');assert.equal(scheduled,0);});
