import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
const q=api.createQueue();q.push('a');assert.deepEqual(await q.next(),{value:'a',done:false});
});
