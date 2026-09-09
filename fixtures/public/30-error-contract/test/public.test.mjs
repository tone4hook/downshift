import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
assert.deepEqual(await api.requestJson(async()=>({status:200,json:async()=>({ok:true})}),'/x'),{ok:true});
});
