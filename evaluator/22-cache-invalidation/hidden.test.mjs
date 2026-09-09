import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('tenant keys are collision free and undefined is cached',async()=>{
 let reads=0;const s=api.createUserService({get:async(t,id)=>{reads++;return t==='none'?undefined:t+id}});
 assert.equal(await s.get('a','x'),'ax');assert.equal(await s.get('b','x'),'bx');await s.get('none','x');await s.get('none','x');assert.equal(reads,3);
 assert.notEqual(api.cacheKey('a:b','c'),api.cacheKey('a','b:c'));
});
test('successful write invalidates one user; failed write retains cache',async()=>{
 let reads=0;let fail=false;const s=api.createUserService({get:async()=>++reads,update:async()=>{if(fail)throw Error('storage');return 7}});
 await s.get('a','x');await s.get('a','y');await s.update('a','x',{});assert.equal(await s.get('a','x'),3);assert.equal(await s.get('a','y'),2);
 fail=true;await assert.rejects(s.update('a','x',{}),/storage/);assert.equal(await s.get('a','x'),3);
});
