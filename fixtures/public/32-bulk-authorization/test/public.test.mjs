import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
api.authorizeDelete({id:'u',tenantId:'t'},{ownerId:'u',tenantId:'t'});
});
