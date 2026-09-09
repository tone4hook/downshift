import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
assert.notEqual(api.cacheKey('a','1'),api.cacheKey('a','2'));
});
