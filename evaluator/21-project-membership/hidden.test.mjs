import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('policy verifies project, activity and publication',()=>{
 const m={projectId:'p',active:true,role:'member'};assert.equal(api.canRead(m,'p',true),true);assert.equal(api.canRead(m,'p',false),false);assert.equal(api.canRead({...m,role:'admin'},'other',true),false);assert.equal(api.canRead({...m,active:false},'p',true),false);
});
test('access precedes storage and output strips secret',async()=>{
 let reads=0;const repo={get:async()=>{reads++;return Object.freeze({id:'d',title:'T',secret:'s'})}};
 await assert.rejects(api.readDocument(repo,{projectId:'q',active:true,role:'admin'},'p','d',true),/FORBIDDEN/);assert.equal(reads,0);
 assert.deepEqual(await api.readDocument(repo,{projectId:'p',active:true,role:'admin'},'p','d',true),{id:'d',title:'T'});
 await assert.rejects(api.readDocument({get:async()=>null},{projectId:'p',active:true,role:'owner'},'p','d',false),/NOT_FOUND/);
});
