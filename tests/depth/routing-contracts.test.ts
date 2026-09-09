import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { SwitchyardBridgeClient } from "../../src/bridge/client.js";
import { callClassifierThroughPi, profileModelRuntime, resolvePiRoles } from "../../src/pi/runtime.js";
import { startMockPiServer } from "../phase01/mock-pi-provider.js";

it.each([[0,0,'weak'],[1,1,'weak'],[0,1,'strong'],[1,0,'weak'],[0.5,0.5,'weak']] as const)('uses the actual Switchyard library at p=%s threshold=%s',async(p,threshold,tier)=>{
 const bridge=await SwitchyardBridgeClient.start(resolve('rust/switchyard-bridge/target/debug/switchyard-bridge'));let calls=0;
 try{const verdict=await bridge.resolveDecision({decisionId:`edge-${p}-${threshold}`,task:'Fix a bounded task',weakThreshold:threshold,maxOutputTokens:256,callClassifier:async()=>{calls++;return {text:JSON.stringify({crux:'bounded',primary_rule:'SUP-1',capability_boundary:'supported',p_solve:p})}}});expect(verdict.selectedAlias).toBe(tier);expect(calls).toBe(1);}finally{await bridge.dispose();}
});

it('rejects oversized classifier input before any provider request, with no fallback tier',async()=>{
 const root=await mkdtemp(join(tmpdir(),'classifier-envelope-'));const server=await startMockPiServer();
 try{const runtime=await profileModelRuntime({authPath:join(root,'auth.json'),modelsPath:null,mockProvider:{baseUrl:server.baseUrl}});const roles=resolvePiRoles(runtime,{classifier:{provider:'mock',model:'classifier'},weak:{provider:'mock',model:'weak'},strong:{provider:'mock',model:'strong'}});
 const output=await callClassifierThroughPi(runtime,roles.classifier,{type:'call_model',decisionId:'d',callId:'c',targetAlias:'classifier',request:{messages:[{role:'user',content:[{type:'text',text:'x'.repeat(40000)}]}],output:{max_output_tokens:256}}});expect(output).toMatchObject({error:{kind:'provider',message:expect.stringContaining('unsupported-input')}});expect(server.state.inferenceModels).toEqual([]);
 }finally{await server.close();await rm(root,{recursive:true,force:true});}
});
