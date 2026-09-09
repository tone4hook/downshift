import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessReadiness, generateReadiness, validateReadinessReport, readinessMetrics, strongIdentityTokens, renderReadiness, type AssessmentRow } from "../../src/evaluation/readiness.js";
import { makeBenchmarkProtocol } from "../../src/evaluation/benchmark.js";
import { digest } from "../../src/evaluation/records.js";
import { FULL_CHECKS, initializeVerification, recordVerification, validateVerificationReport, type VerificationReport } from "../../src/evaluation/verification.js";
import { createSmokeManifest, mulberry32, validateSmokeManifest } from "../../src/evaluation/smoke.js";
import { UsageLedger } from "../../src/artifacts/usage.js";
import { createManifest, roots, result, summary, trial, images } from "./helpers.js";

const cleanup: string[] = [];
async function temporary() { const root=await mkdtemp(join(tmpdir(),"readiness-"));cleanup.push(root);return root; }
afterEach(async()=>{for(const root of cleanup.splice(0))await rm(root,{recursive:true,force:true});});
function rows(count=28): AssessmentRow[] {
  return Array.from({length:count},(_,i)=>({taskId:`t${i}`,clusterId:`t${i}`,routed:i%3===0?0.8:1,strong:i%4===0?0.8:1,routedStrongTokens:i%2===0?20:40,baselineStrongTokens:100}));
}
describe("readiness measurement",()=>{
  it("treats an unused role as zero and a missing dispatched response as unknown",()=>{
    const ledger=new UsageLedger();expect(ledger.summaries().classifier).toMatchObject({status:"complete",totalTokens:0,observedCalls:0});
    ledger.record("missing","classifier",null,false);expect(ledger.summaries().classifier).toMatchObject({status:"unknown",totalTokens:null,missingCalls:1});
  });
  it("counts strong classifier and compaction usage across replacement attempts",async()=>{
    const root=await temporary();const c=await createManifest(root,"usage");const task=c.manifest.tasks[0]!;
    const run=result({id:"r",mode:"routed",task,config:c.config,outcome:"pass",tier:"weak"});
    run.provenance.models.classifier.model="strong";run.usage.classifier=summary(11);run.usage.coding=summary(200);run.usage.compaction=summary(25);
    const attempt=structuredClone(run);attempt.decision!.selectedTier="strong";attempt.servedModel={provider:"mock",model:"strong",providerReportedModelId:"strong"};attempt.usage.classifier=summary(3);attempt.usage.coding=summary(7);attempt.usage.compaction=summary(5);
    const t=trial(task.id,0,"routed",run,[attempt,run]);expect(strongIdentityTokens(t,{provider:"mock",model:"strong"})).toBe(26);
    attempt.usage.coding=summary(null);expect(strongIdentityTokens(t,{provider:"mock",model:"strong"})).toBeNull();
    t.physicalAttempts=[run];t.incompletePhysicalAttempts=1;expect(strongIdentityTokens(t,{provider:"mock",model:"strong"})).toBeNull();
  });
  it("uses equal task weights and keeps all repetitions in their cluster",()=>{
    const base=rows();const measured=readinessMetrics(base,7);
    expect(measured.strongTokenReduction.value).toBeCloseTo(0.7);
    expect(measured.absoluteSuccess.validResamples).toBe(10000);
    expect(readinessMetrics(base,7)).toEqual(measured);
    expect(readinessMetrics(base.flatMap((r)=>Array.from({length:5},()=>({...r}))),7)).toEqual(measured);
    expect(readinessMetrics(base.map((r)=>({...r,clusterId:"shared-template"})),7).qualityDifference.interval).toBeNull();
  });
  it("rejects precision from small, degenerate, zero-denominator or incomplete samples",()=>{
    expect(readinessMetrics(rows(19),1).absoluteSuccess.interval).toBeNull();
    const perfect=rows().map((r)=>({...r,routed:1,strong:1}));
    expect(readinessMetrics(perfect,1).qualityDifference.interval).toBeNull();
    expect(readinessMetrics(perfect,1).absoluteSuccess.interval).toBeNull();
    expect(readinessMetrics(rows().map((r)=>({...r,baselineStrongTokens:0})),1).strongTokenReduction.value).toBeNull();
    const missing=rows();missing[0]!.routedStrongTokens=null;expect(readinessMetrics(missing,1).strongTokenReduction.interval).toBeNull();
    expect(readinessMetrics(rows().map((r)=>({...r,routed:0,strong:0})),1).absoluteSuccess.interval).toBeNull();
  });
  it("gives appropriately broad intervals in seeded correlated boundary simulations",()=>{
    // A regression oracle for clustering and false certainty, not a proof of coverage for every distribution.
    let covered=0;let falsePass=0;let absoluteCovered=0;let tokensCovered=0;
    for(let seed=1;seed<=20;seed++){
      const random=mulberry32(seed);const sample=Array.from({length:28},(_,i)=>{const strong=random()<0.85?1:0;const routed=random()<0.8?1:0;return {taskId:`t${i}`,clusterId:`t${i}`,strong,routed,routedStrongTokens:60+random()*30,baselineStrongTokens:100};});
      const measured=readinessMetrics(sample,seed);const interval=measured.qualityDifference.interval;
      const absolute=measured.absoluteSuccess.interval;const tokens=measured.strongTokenReduction.interval;
      if(absolute&&absolute.lower<=0.8&&absolute.upper>=0.8)absoluteCovered++;
      if(tokens&&tokens.lower<=0.25&&tokens.upper>=0.25)tokensCovered++;
      if(interval&&interval.lower<=-0.05&&interval.upper>=-0.05)covered++;
      if(interval&&interval.lower>=-0.05)falsePass++;
    }
    expect(covered).toBeGreaterThanOrEqual(16);expect(falsePass).toBeLessThanOrEqual(3);expect(absoluteCovered).toBeGreaterThanOrEqual(16);expect(tokensCovered).toBeGreaterThanOrEqual(16);
  },30000);
  it("distinguishes readiness verdicts, incomplete evidence and engineering failures",async()=>{
    const root=await temporary();const dev=await createManifest(root,"dev",3,"combined");
    const benchmark=await makeBenchmarkProtocol(dev.manifest,0.75,roots);
    const heldout=await createSmokeManifest({roots,resultsRoot:root,configPath:dev.configPath,configCheckPath:dev.configCheckPath,experimentId:"heldout",evidenceKind:"mock",suite:"heldout",corpus:"combined",sourceContentHash:"a".repeat(64),seed:benchmark.seed,repetitions:5,benchmark,revision:null,dirty:false,images});
    const vdir=join(root,"verify");await initializeVerification(vdir,"full","a".repeat(64),images,"test");let verification:VerificationReport|undefined;
    for(const id of FULL_CHECKS){await writeFile(join(vdir,`${id}.log`),"synthetic test evidence\n");verification=await recordVerification(vdir,id,id==="mock-smoke"?1:0);}
    const trials=heldout.manifest.schedule.map((scheduled)=>{const task=heldout.manifest.tasks.find((t)=>t.id===scheduled.taskId)!;const i=heldout.manifest.tasks.indexOf(task);const pass=scheduled.mode==='routed'?!(i===0&&scheduled.repetition===0):scheduled.mode==='strong-only'?!(i===1&&scheduled.repetition===0):i%2===0;const run=result({id:scheduled.attemptId,mode:scheduled.mode,task,config:dev.config,outcome:pass?"pass":"fail",tier:scheduled.mode==='strong-only'?'strong':scheduled.mode==='weak-only'?'weak':i%3===0?'strong':'weak'});return trial(task.id,scheduled.repetition,scheduled.mode,run);});
    expect(assessReadiness(heldout.manifest,trials,verification!).verdict).toBe("INCONCLUSIVE");
    // Synthetic live-shaped records exist only in this test's memory, never as claimed live artifacts.
    const live=structuredClone(heldout.manifest);live.evidenceKind='live';live.benchmark!.evidenceKind='live';const {protocolId,...p}=live.benchmark!;live.benchmark!.protocolId=digest(p);const {manifestHash,...m}=live;live.manifestHash=digest(m);validateSmokeManifest(live);
    const pass=assessReadiness(live,trials,verification!);expect(pass.verdict).toBe('PASS');expect(renderReadiness(pass)).toContain('**PASS**');
    const failed=structuredClone(trials);for(const t of failed)if(t.mode==='routed')t.outcome=t.repetition===0?'pass':'fail';expect(assessReadiness(live,failed,verification!).verdict).toBe('FAIL');
    const unavailable=structuredClone(trials);unavailable[0]!.outcome='unavailable';expect(assessReadiness(live,unavailable,verification!).verdict).toBe('INCONCLUSIVE');
    const broken=structuredClone(verification!);broken.checks[0]!.exitCode=1;broken.checks[0]!.status='FAIL';broken.status='FAIL';const {reportHash,...v}=broken;broken.reportHash=digest(v);validateVerificationReport(broken);expect(assessReadiness(live,trials,broken).verdict).toBe('FAIL');
  },30000);
});

it("regenerates matching readiness artifacts offline and rejects changed verification logs",async()=>{
  const root=await temporary();const dev=await createManifest(root,"offline",1,"combined");
  const vdir=join(root,"verification");await initializeVerification(vdir,"quick","a".repeat(64),images,"test");
  await writeFile(join(vdir,"source-images.log"),"synthetic verification evidence\n");await recordVerification(vdir,"source-images",0);
  const report=await generateReadiness(dev.directory,vdir);expect(report.verdict).toBe("INCONCLUSIVE");
  expect(validateReadinessReport(JSON.parse(await readFile(join(dev.directory,"readiness.json"),"utf8")))).toEqual(report);
  expect(await readFile(join(dev.directory,"readiness.md"),"utf8")).toBe(renderReadiness(report));
  expect(await generateReadiness(dev.directory,vdir)).toEqual(report);
  await writeFile(join(vdir,"source-images.log"),"changed");await expect(generateReadiness(dev.directory,vdir)).rejects.toThrow(/log changed/);
});
