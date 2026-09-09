import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
const c=new AbortController();const detach=api.attachAbort(c.signal,()=>{});detach();
});
