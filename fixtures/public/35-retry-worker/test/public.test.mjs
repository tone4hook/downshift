import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
assert.equal(api.retryDelay({retryable:true},1,3,10),10);
});
