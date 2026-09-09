import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('migration preserves disabled and input identity',async()=>{const raw=Object.freeze({version:2,name:'n',connection:Object.freeze({url:'https://x.test'}),enabled:false});const out=await api.profileStore({read:async()=>raw}).load();assert.equal(out.enabled,false);assert.notEqual(out.connection,raw.connection);assert.deepEqual(api.migrateProfile({version:1,name:'n',endpoint:'https://x.test'}),{version:2,name:'n',connection:{url:'https://x.test'},enabled:true});assert.throws(()=>api.migrateProfile({version:3,name:'n',connection:{url:'https://x'}}),/UNSUPPORTED_VERSION/);});
test('invalid schemes never persist',async()=>{let writes=0;const store=api.profileStore({write:async()=>writes++});for(const url of ['file:///tmp/x','javascript:alert(1)','not a url'])await assert.rejects(store.save({version:1,name:'n',endpoint:url}),/INVALID_URL/);assert.equal(writes,0);await store.save({version:1,name:'n',endpoint:'https://x.test'});assert.equal(writes,1);});
