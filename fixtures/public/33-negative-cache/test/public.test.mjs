import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
const c=api.createExpiringCache(10,()=>0);c.write('x',1);assert.deepEqual(c.read('x'),{hit:true,value:1});
});
