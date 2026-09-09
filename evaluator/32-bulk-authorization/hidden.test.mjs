import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('validates whole batch before deletion and keeps admins tenant scoped',async()=>{const calls=[];const rows={a:{tenantId:'t',ownerId:'u'},b:{tenantId:'other',ownerId:'u'}};const repo={get:async id=>rows[id],remove:async ids=>calls.push(ids)};for(const role of ['admin','member'])await assert.rejects(api.deleteMany(repo,{id:'u',tenantId:'t',role},['a','b']),/FORBIDDEN/);assert.deepEqual(calls,[]);await assert.rejects(api.deleteMany(repo,{id:'u',tenantId:'t'},['a','missing']),/NOT_FOUND/);assert.deepEqual(calls,[]);});
test('deduplicates in order and skips empty',async()=>{const calls=[];const repo={get:async id=>{calls.push(id);return {tenantId:'t',ownerId:'u'}},remove:async ids=>calls.push(ids)};assert.equal(await api.deleteMany(repo,{id:'u',tenantId:'t'},['b','a','b']),2);assert.deepEqual(calls,['b','a',['b','a']]);assert.equal(await api.deleteMany(repo,{},[]),0);assert.equal(calls.length,3);});
