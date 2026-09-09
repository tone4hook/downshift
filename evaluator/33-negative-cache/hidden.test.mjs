import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('null cached through TTL and boundary expires',async()=>{let now=0,calls=0;const d=api.createDirectory(async()=>{calls++;return null},10,()=>now);await d.find('x');await d.find('x');assert.equal(calls,1);now=10;await d.find('x');assert.equal(calls,2);await d.find('y');assert.equal(calls,3);});
test('exceptions are retried and invalid TTL rejected',async()=>{let calls=0;const d=api.createDirectory(async()=>{if(++calls===1)throw Error('wire');return 'ok'},10,()=>0);await assert.rejects(d.find('x'),/wire/);assert.equal(await d.find('x'),'ok');assert.equal(calls,2);for(const ttl of [-1,NaN,Infinity])assert.throws(()=>api.createExpiringCache(ttl,()=>0),/INVALID_TTL/);});
