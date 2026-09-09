import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
const s=api.createSettings(async()=>1);s.set('a',2);assert.equal(s.get('a'),2);
});
