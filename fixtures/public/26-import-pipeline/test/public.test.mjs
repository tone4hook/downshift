import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
assert.deepEqual(api.parseRows('a,2').rows,[{sku:'a',quantity:2}]);
});
