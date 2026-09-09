import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('physical lines and all diagnostics',()=>{assert.deepEqual(api.parseRows('a,2\r\n\n bad\na,3\nx,1.5').errors,[{line:3,code:'INVALID_ROW'},{line:4,code:'DUPLICATE_SKU'},{line:5,code:'INVALID_ROW'}]);});
test('atomic validation before storage and single batch on success',async()=>{let batches=[];const repo={saveBatch:async rows=>batches.push(rows)};assert.equal((await api.importInventory('a,2\nbad',repo)).ok,false);assert.equal(batches.length,0);assert.deepEqual(await api.importInventory(' a , 2\r\nb,3\n',repo),{ok:true,count:2});assert.deepEqual(batches,[[{sku:'a',quantity:2},{sku:'b',quantity:3}]]);});
