import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
const api=await import(pathToFileURL(process.cwd()+'/src/index.ts').href);
test('precedence and false are preserved without mutation', async () => {
 const file = Object.freeze({port: 9, dryRun: true}); let calls = 0;
 assert.deepEqual(await api.planDeploy(file, {DEPLOY_PORT:'10', DEPLOY_DRY_RUN:'true'}, {port:11,dryRun:false}, async () => calls++), {port:11,dryRun:false}); assert.equal(calls,1);
 assert.equal((await api.planDeploy({}, {DEPLOY_PORT:''}, {dryRun:true}, ()=>{})).port,3000);
});
test('strict port parsing rejects partial and out of range values before deployment', async()=>{
 for(const port of ['1.5','12x','-1','0','65536',NaN,Infinity]) { let calls=0; await assert.rejects(api.planDeploy({}, {}, {port}, ()=>calls++), /INVALID_PORT/); assert.equal(calls,0); }
 assert.equal(api.parsePort('65535'),65535);
});
