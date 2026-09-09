import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('opaque cursor and empty intermediary page',async()=>{const calls=[];const pages=[{items:[1],nextCursor:' 0 '},{items:[],nextCursor:'x'},{items:[2]}];assert.deepEqual(await api.fetchAll(async c=>{calls.push(c);return pages.shift()}),[1,2]);assert.deepEqual(calls,[null,' 0 ','x']);});
test('repeated cursor stops before duplicate fetch',async()=>{let calls=0;await assert.rejects(api.fetchAll(async()=>{if(++calls>3)throw Error('too many');return {items:[],nextCursor:'a'}}),/CURSOR_LOOP/);assert.equal(calls,2);assert.throws(()=>api.decodePage({items:[],nextCursor:1}),/INVALID_PAGE/);});
