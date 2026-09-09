import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('rejects traversal and link paths before any write',async()=>{for(const path of ['../x','a/../x','/x','a//b','a/./b','C:x','a\\b']){let calls=0;await assert.rejects(api.importArchive([{path:'ok',type:'file',content:'a'},{path,type:'file',content:'b'}],100,()=>calls++),/INVALID_ARCHIVE/);assert.equal(calls,0);}await assert.rejects(api.importArchive([{path:'x',type:'symlink',content:'a'}],10,()=>{}),/INVALID_ARCHIVE/);});
test('total UTF8 bytes and duplicates validated before write',async()=>{let calls=[];const entries=[{path:'a',type:'file',content:'é'},{path:'b',type:'file',content:'é'}];await assert.rejects(api.importArchive(entries,3,(...args)=>calls.push(args)),/INVALID_ARCHIVE/);assert.deepEqual(calls,[]);assert.equal(await api.importArchive(entries,4,(...args)=>calls.push(args)),2);assert.deepEqual(calls,[['a','é'],['b','é']]);await assert.rejects(api.importArchive([entries[0],entries[0]],10,()=>{}),/INVALID_ARCHIVE/);});
