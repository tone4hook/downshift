import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('idempotent reservation and conflict detection',async()=>{let stock=5;let rows=new Map();let fail=false;const repo={insert:async()=>{throw Error('outside')},transaction:async fn=>{let draft=stock;const saved=new Map(rows);const out=await fn({find:async id=>saved.get(id),stock:async()=>draft,take:async(_,q)=>draft-=q,insert:async r=>{if(fail)throw Error('storage');saved.set(r.requestId,r)}});stock=draft;rows=saved;return out;}};const a=await api.reserve(repo,'r','s',2);assert.deepEqual(await api.reserve(repo,'r','s',2),a);assert.equal(stock,3);await assert.rejects(api.reserve(repo,'r','s',1),/IDEMPOTENCY_CONFLICT/);fail=true;await assert.rejects(api.reserve(repo,'r2','s',1),/storage/);assert.equal(stock,3);assert.equal(rows.size,1);});
test('quantity validity',()=>{for(const q of [0,1.5,-1,Infinity])assert.throws(()=>api.reservationInput('s',q),/INVALID_RESERVATION/);});
