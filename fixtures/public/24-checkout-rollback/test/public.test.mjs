import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../src/index.ts';
test('public API regression',async()=>{
assert.deepEqual(api.aggregateLines([{sku:'x',quantity:1}]),[{sku:'x',quantity:1}]);
});
