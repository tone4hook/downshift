import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('normalizes both versions and preserves frozen input', async()=>{
 for(const payload of [Object.freeze({id:'a',name:' Ada '}), Object.freeze({account:Object.freeze({id:'a',displayName:' Ada '})})]) assert.deepEqual(await api.createAccountClient(async()=>payload).get('a'),{id:'a',displayName:'Ada'});
 assert.throws(()=>api.decodeAccount({account:{name:'x'}}),/INVALID_ACCOUNT/);
});
test('encoded identifier reaches transport',async()=>{let url; await api.createAccountClient(async(u)=>{url=u;return {id:'a',name:'A'}}).get('a/b ?');assert.equal(url,'/accounts/a%2Fb%20%3F');});
