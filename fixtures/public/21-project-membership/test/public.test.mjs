import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
assert.equal(api.canRead({projectId:'p',active:true,role:'admin'},'p',true),true);
});
