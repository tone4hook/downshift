import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('aggregates and validates without mutation',()=>{const lines=Object.freeze([Object.freeze({sku:'a',quantity:2}),Object.freeze({sku:'a',quantity:3})]);assert.deepEqual(api.aggregateLines(lines),[{sku:'a',quantity:5}]);for(const q of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>api.aggregateLines([{sku:'a',quantity:q}]),/INVALID_QUANTITY/);});
test('sum overflow rejected',()=>{assert.throws(()=>api.aggregateLines([{sku:'a',quantity:Number.MAX_SAFE_INTEGER},{sku:'a',quantity:1}]),/INVALID_QUANTITY/);});
test('order and inventory use one rollback boundary',async()=>{
 let stock=5;let fail=true;const repo={order:async()=>{throw Error('outside')},transaction:async(fn)=>{let draft=stock;const result=await fn({stock:async()=>draft,take:async(_,q)=>draft-=q,order:async(lines)=>{if(fail)throw Error('storage');return {lines}}});stock=draft;return result;}};
 await assert.rejects(api.checkout(repo,[{sku:'a',quantity:2}]),/storage/);assert.equal(stock,5);fail=false;assert.deepEqual(await api.checkout(repo,[{sku:'a',quantity:2},{sku:'a',quantity:1}]),{lines:[{sku:'a',quantity:3}]});assert.equal(stock,2);
 await assert.rejects(api.checkout(repo,[{sku:'a',quantity:3}]),/OUT_OF_STOCK/);assert.equal(stock,2);
});
