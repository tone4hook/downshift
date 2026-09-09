import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('revocation, resource and exact expiry',()=>{const link={resourceId:'a',expiresAt:10,revoked:false};assert.equal(api.permitsLink(link,'a',9),true);assert.equal(api.permitsLink(link,'a',10),false);assert.equal(api.permitsLink(link,'b',1),false);assert.equal(api.permitsLink({...link,revoked:true},'a',1),false);});
test('no storage on denied link, projection on success',async()=>{let reads=0;const repo={link:async()=>({resourceId:'a',expiresAt:10}),resource:async()=>{reads++;return Object.freeze({id:'a',title:'T',internalToken:'s'})}};await assert.rejects(api.openShared(repo,'k','a',()=>10),/FORBIDDEN/);assert.equal(reads,0);assert.deepEqual(await api.openShared(repo,'k','a',()=>9),{id:'a',title:'T'});await assert.rejects(api.openShared({...repo,resource:async()=>null},'k','a',()=>9),/NOT_FOUND/);});
