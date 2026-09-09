import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
assert.equal(api.permitsLink({resourceId:'a',expiresAt:null},'a',100),true);
});
