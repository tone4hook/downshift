import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
assert.equal(api.compareRecords({id:'a',updatedAt:1},{id:'b',updatedAt:2}),-1);
});
