import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { corpusDefinition, HARNESS_DEV, HARNESS_HELDOUT, routingWordings } from "../../src/evaluation/corpus.js";
import { createEvaluationPlan, createSmokeManifest, validateSmokeManifest } from "../../src/evaluation/smoke.js";
import { makeBenchmarkProtocol, validateBenchmarkProtocol, verifyBenchmarkExecution } from "../../src/evaluation/benchmark.js";
import { randomSelectionReplay, validateFrozenPolicy, freezePolicy, generateExperimentReport } from "../../src/evaluation/analysis.js";
import { prepareRoutingProbe, reportRoutingProbe } from "../../src/evaluation/probe.js";
import { loadTaskDefinition } from "../../src/evaluation/task.js";
import { digest } from "../../src/evaluation/records.js";
import { createManifest, roots, images, result, trial, populateExperiment } from "./helpers.js";
const cleanup:string[]=[];
async function temp(){const p=await mkdtemp(join(tmpdir(),'corpus-protocol-'));cleanup.push(p);return p;}
afterEach(async()=>{for(const p of cleanup.splice(0))await rm(p,{recursive:true,force:true});});

it('preserves core suites and exposes 24 independent multi-file tasks with bound validators',async()=>{
  const root=await temp();const c=await createManifest(root,'core');
  expect(c.manifest.schemaVersion).toBe(1);expect(validateSmokeManifest(c.manifest)).toEqual(c.manifest);
  expect(corpusDefinition('core').tasks).toHaveLength(18);expect(HARNESS_DEV).toHaveLength(8);expect(HARNESS_HELDOUT).toHaveLength(16);
  const all=corpusDefinition('combined').tasks;expect(new Set(all.map((t)=>t.id)).size).toBe(42);expect(new Set(all.map((t)=>t.clusterId)).size).toBe(42);
  for(const id of [...HARNESS_DEV,...HARNESS_HELDOUT]){
    const loaded=await loadTaskDefinition(id,roots);expect(loaded.definition.fixture.files.filter((f)=>f.path.startsWith('src/')).length).toBeGreaterThanOrEqual(3);
    const validator=JSON.parse(await readFile(join(loaded.evaluatorDirectory,'validator.json'),'utf8'));expect(validator.mutantDirectories.length).toBeGreaterThanOrEqual(1);
  }
  expect(createEvaluationPlan(c.config,{suite:'dev',corpus:'combined',repetitions:3,seed:1})).toMatchObject({taskCount:14,codingTrials:126,expectedClassifierCalls:42});
  expect(createEvaluationPlan(c.config,{suite:'heldout',corpus:'combined',repetitions:5,seed:1,meanAgentMs:1000})).toMatchObject({taskCount:28,codingTrials:420,expectedClassifierCalls:140,projectedAgentSeconds:420});
});

it('binds the frozen schedule, corpus, source, models, images and targets before held-out dispatch',async()=>{
  const root=await temp();const dev=await createManifest(root,'dev',3,'combined');
  const protocol=await makeBenchmarkProtocol(dev.manifest,0.75,roots);
  const opts={corpus:'combined' as const,suite:'heldout',repetitions:5,seed:protocol.seed,evidenceKind:'mock' as const,sourceContentHash:'a'.repeat(64),images,configuration:dev.config,roots};
  await expect(verifyBenchmarkExecution(protocol,opts)).resolves.toBeUndefined();
  for(const changes of [{repetitions:6},{maxCostUsd:5},{seed:2},{corpus:'core' as const},{sourceContentHash:'f'.repeat(64)},{images:{...images,agent:'sha256:'+'f'.repeat(64)}},{evidenceKind:'live' as const}])await expect(verifyBenchmarkExecution(protocol,{...opts,...changes})).rejects.toThrow(/changed/);
  const tamper=structuredClone(protocol);(tamper.targets as {absoluteSuccess:number}).absoluteSuccess=0.1;const {protocolId,...rest}=tamper;tamper.protocolId=digest(rest);expect(()=>validateBenchmarkProtocol(tamper)).toThrow(/targets/);
  const made=await createSmokeManifest({roots,resultsRoot:root,configPath:dev.configPath,configCheckPath:dev.configCheckPath,experimentId:'heldout',evidenceKind:'mock',suite:'heldout',corpus:'combined',sourceContentHash:'a'.repeat(64),seed:protocol.seed,repetitions:5,benchmark:protocol,revision:null,dirty:false,images});
  expect(made.manifest.schemaVersion).toBe(2);expect(JSON.parse(await readFile(join(made.directory,'protocol.json'),'utf8'))).toEqual(protocol);
  const altered=structuredClone(made.manifest);altered.benchmark!.repetitions=6 as 5;expect(()=>validateSmokeManifest(altered)).toThrow();
  expect(()=>validateFrozenPolicy({schemaVersion:3})).toThrow();
});

it('preserves observed weak share and fallback in a deterministic, explicitly counterfactual control',async()=>{
  const root=await temp();const c=await createManifest(root,'control');
  const records=c.manifest.tasks.flatMap((task,i)=>['weak-only','strong-only','routed'].map((mode)=>trial(task.id,0,mode as 'routed',result({id:`${task.id}-${mode}`,mode:mode as 'routed',task,config:c.config,outcome:mode==='strong-only'||i%2===0?'pass':'fail',tier:i%2===0?'weak':'strong',fallback:i===5}))));
  const replay=randomSelectionReplay(c.manifest,records);expect(replay).toEqual(randomSelectionReplay(c.manifest,records));expect(replay).toMatchObject({evidenceKind:'replay',sourceEvidenceKind:'mock',weakSelections:3,recordedDecisions:6});expect(replay.selections[5]!.tier).toBe('strong');
  const heldout=structuredClone(c.manifest);heldout.suite='heldout';expect(()=>randomSelectionReplay(heldout,records)).toThrow(/development/);
});

it('keeps wording probes diagnostic and preserves failed partial output',async()=>{
  const root=await temp();const prompt='Fix x without changing y.';expect(new Set(routingWordings(prompt)).size).toBe(3);expect(routingWordings(prompt).every((p)=>p.includes(prompt))).toBe(true);
  await writeFile(join(root,'probe-plan.json'),JSON.stringify({evidenceKind:'mock',sourceManifestHash:'x',planHash:'p',jobs:[{taskId:'t',wording:0,sample:0},{taskId:'t',wording:0,sample:1}]}));
  await writeFile(join(root,'samples.jsonl'),JSON.stringify({planHash:'p',taskId:'t',wording:0,sample:0,status:'error',durationMs:10})+'\n');
  await reportRoutingProbe(root,3);const report=JSON.parse(await readFile(join(root,'routing-probe.json'),'utf8'));expect(report).toMatchObject({kind:'classifier-diagnostic',status:'incomplete',planned:2,recorded:1});
  const c=await createManifest(root,'incomplete');await expect(prepareRoutingProbe(c.directory,root,'live')).rejects.toThrow(/development/);
});

it('round-trips version 2 freezes and regenerates reports offline without re-execution',async()=>{
  const root=await temp();const dev=await createManifest(root,'frozen',1,'combined');
  await populateExperiment(dev);
  const policy=await freezePolicy(dev.directory,0.75,undefined,{benchmarkProfile:'harness-v1',roots});
  expect(policy.schemaVersion).toBe(2);expect(validateFrozenPolicy(policy)).toEqual(policy);
  expect(await freezePolicy(dev.directory,0.75,undefined,{benchmarkProfile:'harness-v1',roots})).toEqual(policy);
  await expect(freezePolicy(dev.directory,0.8,undefined,{benchmarkProfile:'harness-v1',roots})).rejects.toThrow(/immutable/);
  const before=await generateExperimentReport(dev.directory);const text=await readFile(join(dev.directory,'experiment.md'),'utf8');
  expect(await generateExperimentReport(dev.directory)).toEqual(before);expect(await readFile(join(dev.directory,'experiment.md'),'utf8')).toBe(text);
  const changed=structuredClone(policy);changed.benchmark!.configuration.execution.maxAgentTurns++;expect(()=>validateFrozenPolicy(changed)).toThrow();
},30000);
