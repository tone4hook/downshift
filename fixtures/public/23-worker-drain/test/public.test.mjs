import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
const w=api.createWorker(async x=>x);assert.equal(await w.enqueue(3),3);
});
