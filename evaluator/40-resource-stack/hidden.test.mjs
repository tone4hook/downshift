import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('LIFO cleanup continues through errors and is idempotent',async()=>{const s=api.createResourceStack(),order=[];const a=Error('a'),b=Error('b');s.use(async()=>{order.push('a');throw a});s.use(async()=>{order.push('b');throw b});const p=s.dispose();assert.throws(()=>s.use(()=>{}),/CLOSED/);await assert.rejects(p,e=>e instanceof AggregateError&&e.errors[0]===b&&e.errors[1]===a);await assert.rejects(s.dispose());assert.deepEqual(order,['b','a']);});
test('setup error preserved after cleanup',async()=>{let closed=0;const error=Error('setup');await assert.rejects(api.setupSession(async()=>({close:async()=>closed++}),async()=>{throw error}),e=>e===error);assert.equal(closed,1);const session=await api.setupSession(async()=>({close:async()=>closed++}),async()=>7);assert.equal(session.value,7);await session.close();await session.close();assert.equal(closed,2);});
