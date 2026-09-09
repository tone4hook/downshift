import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('204 avoids parsing and transport failures preserve identity',async()=>{assert.equal(await api.requestJson(async()=>({status:204,json(){throw Error('parsed')}}),'/x'),null);const error=Error('wire');let calls=0;await assert.rejects(api.requestJson(async()=>{calls++;throw error},'/x'),e=>e===error);assert.equal(calls,1);});
test('error contract survives invalid JSON',async()=>{for(const status of [400,401,404,429,500,503])await assert.rejects(api.requestJson(async()=>({status,json:async()=>{throw Error('bad json')}}),'/x'),e=>e instanceof api.RequestError&&e.status===status&&e.code==='HTTP_ERROR'&&e.retryable===(status===429||status>=500));assert.equal(new api.RequestError(400,{code:'BAD_INPUT'}).code,'BAD_INPUT');});
