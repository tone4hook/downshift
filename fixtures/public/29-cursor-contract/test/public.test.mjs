import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
assert.deepEqual(api.decodePage({items:[1]}),{items:[1],nextCursor:null});
});
