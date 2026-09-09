import { corpusTasks, type CorpusId } from "./corpus.js";
import { sourceContentHash, readJson, digest } from "./records.js";
import { initializeVerification, recordVerification, verifyMockLedger } from "./verification.js";
import { generateReadiness } from "./readiness.js";
import { prepareRoutingProbe, reportRoutingProbe } from "./probe.js";
import { verifyBenchmarkExecution } from "./benchmark.js";
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { collectAttempt } from "./collect-attempt.js";
import { resolve } from "node:path";
import {
  assertExperimentDirectory,
  createEvaluationPlan,
  conservativeTrialCostBound,
  createSmokeManifest,
  generateSmokeReport,
  jobAt,
  nextEvaluationAction,
  readSmokeManifest,
  smokeExitCode,
  verifyResumeCompatibility,
  type EvaluationSuite,
} from "./smoke.js";
import {
  freezePolicy,
  validateFrozenPolicy,
  loadExperimentRecords,
  generateExperimentReport,
  generateThresholdReplay,
  renderExperimentTerminal,
  verifyHeldoutPolicy,
} from "./analysis.js";
import { loadConfig } from "../config/lab-config.js";
import { classifyTrialOutcome, readAttempt } from "../artifacts/run-artifacts.js";
import type { EvaluationRoots } from "./task.js";

function roots(): EvaluationRoots {
  return {
    tasksRoot: process.env.LAB_TASKS_ROOT ?? "/evaluation/tasks",
    fixturesRoot: process.env.LAB_FIXTURES_ROOT ?? "/evaluation/fixtures",
    evaluatorRoot: process.env.LAB_EVALUATOR_ROOT ?? "/evaluation/evaluator",
  };
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function nullable(value: string): string | null {
  return value === "-" ? null : value;
}

const command = process.argv[2];
if (command === "source-hash") {
  process.stdout.write(await sourceContentHash(required(process.argv[3], "source directory")) + "\n");
} else if (command === "task-ids") {
  process.stdout.write(corpusTasks((process.argv[4] ?? "core") as CorpusId, required(process.argv[3], "suite") as EvaluationSuite).join(" ") + "\n");
} else if (command === "verify-init") {
  await initializeVerification(required(process.argv[3], "directory"), required(process.argv[4], "level") as "quick" | "full", required(process.argv[5], "source hash"), {agent:required(process.argv[6], "agent image"),evaluator:required(process.argv[7], "evaluator image"),mock:required(process.argv[8], "mock image")}, required(process.argv[9], "platform"), process.argv[10]);
} else if (command === "verify-record") {
  const report = await recordVerification(required(process.argv[3], "directory"),required(process.argv[4], "check"),Number(required(process.argv[5], "exit code")));
  process.stdout.write(`${report.checks.at(-1)!.id}: ${report.checks.at(-1)!.status}\n`);
} else if (command === "verify-ledger") {
  await verifyMockLedger(required(process.argv[3], "experiment"));
  process.stdout.write("Provider ledger and expected smoke matrix agree\n");
} else if (command === "assess") {
  try {
    const report = await generateReadiness(required(process.argv[3], "experiment"), required(process.argv[4], "verification"));
    process.stdout.write(`readiness:${report.verdict}\n${report.reasons.join("\n")}\n`);
    process.exitCode = report.verdict === "PASS" ? 0 : report.verdict === "FAIL" ? 1 : 4;
  } catch {
    process.stderr.write("Readiness evidence is invalid or unreadable; no assessment was produced\n");
    process.exitCode = 3;
  }
} else if (command === "probe-plan") {
  await prepareRoutingProbe(required(process.argv[3], "experiment"), required(process.argv[4], "output"), required(process.argv[5], "evidence") as "mock" | "live");
} else if (command === "probe-report") {
  await reportRoutingProbe(required(process.argv[3], "directory"), Number(required(process.argv[4], "exit code")));
} else if (command === "collect-attempt") {
  await collectAttempt(resolve(required(process.argv[3], "source")), resolve(required(process.argv[4], "destination")));
} else if (command === "resume-config") {
  const manifest = await readSmokeManifest(resolve(required(process.argv[3], "manifest")));
  const evidence = required(process.argv[5], "evidence kind");
  if (manifest.evidenceKind !== evidence) throw new Error("Resume evidence kind does not match; live experiments require --live");
  await writeFile(resolve(required(process.argv[4], "configuration output")), JSON.stringify(manifest.configuration), { mode: 0o600 });
  process.stdout.write(`auth-profile:${manifest.authProfile}\n`);
} else if (command === "plan") {
  const suite = required(process.argv[4], "suite") as EvaluationSuite;
  const repetitions = Number.parseInt(required(process.argv[5], "repetitions"), 10);
  const seed = Number.parseInt(required(process.argv[6], "seed"), 10);
  const config = await loadConfig(resolve(required(process.argv[3], "config path")));
  let meanAgentMs: number | undefined;
  if (process.argv[8] && process.argv[8] !== "-") {
    const dev = await loadExperimentRecords(process.argv[8]);
    if (dev.manifest.suite !== "dev" || JSON.stringify(dev.manifest.roles) !== JSON.stringify(config.models) || JSON.stringify(dev.manifest.limits) !== JSON.stringify(config.execution)) throw new Error("Runtime projection requires compatible development measurements");
    const durations = dev.trials.flatMap((t)=>t.result?.durationsMs.agent === null || !t.result ? [] : [t.result.durationsMs.agent]);
    if (durations.length) meanAgentMs = durations.reduce((a,b)=>a+b,0)/durations.length;
  }
  const plan = createEvaluationPlan(config, { suite, repetitions, seed, corpus: (process.argv[7] ?? "core") as CorpusId, ...(meanAgentMs === undefined ? {} : { meanAgentMs }) });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  process.stderr.write(
    `Evaluation plan: suite=${suite} tasks=${plan.taskCount} modes=${plan.modes.length} ` +
      `repetitions=${repetitions} coding-trials=${plan.codingTrials} ` +
      `classifier-calls=${plan.expectedClassifierCalls} ` +
      `monetary-limit=${plan.billing.monetaryLimitSupported ? "available" : "unavailable"}\n`,
  );
  if (!plan.available) {
    throw new Error(`Suite ${suite} is unavailable until its task corpus is populated`);
  }
} else if (command === "budget-check") {
  const config = await loadConfig(resolve(required(process.argv[3], "config path")));
  const maximum = Number.parseFloat(required(process.argv[4], "maximum cost"));
  if (!Number.isFinite(maximum) || maximum <= 0) {
    throw new Error("Maximum cost must be a positive finite USD amount");
  }
  const requiredReserve = Math.max(
    ...(["weak-only", "strong-only", "routed"] as const).map((mode) =>
      conservativeTrialCostBound(config, mode),
    ),
  );
  if (requiredReserve > maximum) {
    throw new Error(
      `Insufficient monetary budget before first trial: required ${requiredReserve}, available ${maximum}`,
    );
  }
  process.stdout.write(`${JSON.stringify({ maximum, requiredReserve })}\n`);
} else if (command === "create") {
  const policy = process.argv[21] && process.argv[21] !== "-" ? validateFrozenPolicy(await readJson(process.argv[21])) : undefined;
  const result = await createSmokeManifest({
    roots: roots(),
    resultsRoot: resolve(required(process.argv[3], "results root")),
    configPath: resolve(required(process.argv[4], "config path")),
    configCheckPath: resolve(required(process.argv[5], "config check path")),
    experimentId: required(process.argv[6], "experiment ID"),
    evidenceKind: required(process.argv[7], "evidence kind") as "mock" | "live",
    suite: (process.argv[18] ?? "smoke") as EvaluationSuite,
    corpus: (process.argv[19] ?? "core") as CorpusId,
    ...(process.argv[20] && process.argv[20] !== "-" ? { sourceContentHash: process.argv[20] } : {}),
    ...(policy?.benchmark ? { benchmark: policy.benchmark } : {}),
    seed: Number.parseInt(required(process.argv[8], "seed"), 10),
    repetitions: Number.parseInt(required(process.argv[14], "repetitions"), 10),
    maxCostUsd:
      required(process.argv[15], "maximum cost") === "-"
        ? null
        : Number.parseFloat(required(process.argv[15], "maximum cost")),
    revision: nullable(required(process.argv[9], "revision")),
    dirty:
      required(process.argv[10], "dirty state") === "-"
        ? null
        : required(process.argv[10], "dirty state") === "true",
    images: {
      agent: required(process.argv[11], "agent image"),
      evaluator: required(process.argv[12], "evaluator image"),
      mock: nullable(required(process.argv[13], "mock image")),
    },
    lockPaths: {
      pnpm: resolve(required(process.argv[16], "pnpm lock path")),
      cargo: resolve(required(process.argv[17], "Cargo lock path")),
    },
  });
  process.stdout.write(`experiment-id:${result.manifest.experimentId}\n`);
  process.stdout.write(`experiment-directory:${result.directory}\n`);
  process.stdout.write(`matrix:${result.manifest.schedule.length}\n`);
  for (const role of ["classifier", "weak", "strong"] as const) {
    const model = result.manifest.roles[role];
    process.stdout.write(
      `role:${role}:${model.provider}/${model.model}:billing=${model.billing ?? "unknown"}\n`,
    );
  }
} else if (command === "job") {
  const manifest = await readSmokeManifest(resolve(required(process.argv[3], "manifest path")));
  const job = jobAt(
    manifest,
    Number.parseInt(required(process.argv[4], "job index"), 10),
    Number.parseInt(process.argv[5] ?? "0", 10),
  );
  process.stdout.write(`storage-key:${digest([manifest.experimentId, job.attemptId]).slice(0,24)}\n`);
  process.stdout.write(`repetition:${job.repetition}\n`);
  process.stdout.write(`task-id:${job.taskId}\n`);
  process.stdout.write(`mode:${job.mode}\n`);
  process.stdout.write(`attempt-id:${job.attemptId}\n`);
  process.stdout.write(`task-hash:${job.taskHash}\n`);
  process.stdout.write(`source-hash:${job.sourceHash}\n`);
  process.stdout.write(`validator-hash:${job.validatorHash}\n`);
  process.stdout.write(`prompt-base64:${Buffer.from(job.publicPrompt).toString("base64")}\n`);
  process.stdout.write(`previous-attempt-id:${job.previousAttemptId ?? "-"}\n`);
} else if (command === "next") {
  const directory = resolve(required(process.argv[3], "experiment directory"));
  const next = await nextEvaluationAction(directory);
  process.stdout.write(`action:${next.action}\n`);
  if (next.action !== "done") {
    const { job } = next;
    const manifest = await readSmokeManifest(resolve(directory, "manifest.json"));
    process.stdout.write(`storage-key:${digest([manifest.experimentId, job.attemptId]).slice(0,24)}\n`);
    process.stdout.write(`repetition:${job.repetition}\n`);
    process.stdout.write(`task-id:${job.taskId}\n`);
    process.stdout.write(`mode:${job.mode}\n`);
    process.stdout.write(`attempt-id:${job.attemptId}\n`);
    process.stdout.write(`previous-attempt-id:${job.previousAttemptId ?? "-"}\n`);
    process.stdout.write(`task-hash:${job.taskHash}\n`);
    process.stdout.write(`source-hash:${job.sourceHash}\n`);
    process.stdout.write(`validator-hash:${job.validatorHash}\n`);
    process.stdout.write(`prompt-base64:${Buffer.from(job.publicPrompt).toString("base64")}\n`);
  }
} else if (command === "verify-resume") {
  const manifest = await verifyResumeCompatibility({
    experimentDirectory: resolve(required(process.argv[3], "experiment directory")),
    ...(process.argv[12] ? { sourceContentHash: process.argv[12] } : {}),
    roots: roots(),
    configPath: resolve(required(process.argv[4], "config path")),
    configCheckPath: resolve(required(process.argv[5], "config check path")),
    evidenceKind: required(process.argv[6], "evidence kind") as "mock" | "live",
    images: {
      agent: required(process.argv[7], "agent image"),
      evaluator: required(process.argv[8], "evaluator image"),
      mock: nullable(required(process.argv[9], "mock image")),
    },
    lockPaths: {
      pnpm: resolve(required(process.argv[10], "pnpm lock path")),
      cargo: resolve(required(process.argv[11], "Cargo lock path")),
    },
  });
  process.stdout.write(`experiment-id:${manifest.experimentId}\n`);
  process.stdout.write(`matrix:${manifest.schedule.length}\n`);
} else if (command === "attempt") {
  const attempt = await readAttempt(resolve(required(process.argv[3], "attempt directory")));
  process.stdout.write(`status:${attempt.status}\n`);
  if (attempt.result) {
    process.stdout.write(`execution-status:${attempt.result.execution.status}\n`);
    process.stdout.write(`validation-status:${attempt.result.validation.status}\n`);
    process.stdout.write(`outcome:${classifyTrialOutcome(attempt.result)}\n`);
  }
} else if (command === "report") {
  const directory = resolve(required(process.argv[3], "experiment directory"));
  await assertExperimentDirectory(directory);
  const report = await generateExperimentReport(directory);
  process.stdout.write(`${renderExperimentTerminal(report)}\n`);
} else if (command === "thresholds") {
  const directory = resolve(required(process.argv[3], "experiment directory"));
  const generated = await generateThresholdReplay(
    directory,
    required(process.argv[4], "split"),
    process.argv[5] ? resolve(process.argv[5]) : undefined,
  );
  process.stdout.write(`evidence-kind:replay\n`);
  process.stdout.write(`threshold-replay-directory:${generated.directory}\n`);
  process.stdout.write(`threshold-rows:${generated.replay.rows.length}\n`);
} else if (command === "freeze") {
  const directory = resolve(required(process.argv[3], "experiment directory"));
  const threshold = Number.parseFloat(required(process.argv[4], "threshold"));
  const profile = process.argv[5];
  if (profile && profile !== "-" && profile !== "harness-v1") throw new Error("Unknown benchmark profile");
  const policy = await freezePolicy(directory, threshold, undefined, profile === "harness-v1" ? { benchmarkProfile: profile, roots: roots(), priorExposure: process.argv[6] && process.argv[6] !== "-" ? [process.argv[6]] : [] } : undefined);
  process.stdout.write(`policy-id:${policy.policyId}\n`);
  process.stdout.write(`policy-path:${resolve(directory, "policy.json")}\n`);
  process.stdout.write(`threshold:${policy.threshold}\n`);
} else if (command === "verify-policy") {
  const policy = await verifyHeldoutPolicy({
    policyPath: resolve(required(process.argv[3], "policy path")),
    configPath: resolve(required(process.argv[4], "config path")),
    configCheckPath: resolve(required(process.argv[5], "config check path")),
  });
  if (policy.benchmark) await verifyBenchmarkExecution(policy.benchmark, { corpus: required(process.argv[6], "corpus") as CorpusId, suite: required(process.argv[7], "suite"), repetitions: Number(process.argv[8]), seed: Number(process.argv[9]), evidenceKind: required(process.argv[10], "evidence") as "mock" | "live", sourceContentHash: required(process.argv[11], "source hash"), images: {agent:required(process.argv[12], "agent image"),evaluator:required(process.argv[13], "evaluator image")}, configuration: await loadConfig(required(process.argv[4], "configuration")), maxCostUsd: process.argv[14] && process.argv[14] !== "-" ? Number(process.argv[14]) : null, roots: roots() });
  process.stdout.write(`policy-id:${policy.policyId}\n`);
  process.stdout.write(`threshold:${policy.threshold}\n`);
} else if (command === "status") {
  const directory = resolve(required(process.argv[3], "experiment directory"));
  await assertExperimentDirectory(directory);
  const report = await generateSmokeReport(directory);
  process.stdout.write(`${JSON.stringify({
    experimentId: report.experimentId,
    evidenceKind: report.evidenceKind,
    planned: report.planned,
    evaluated: report.evaluated,
    missing: report.missing,
    failures: Object.values(report.modeResults).reduce((sum, mode) => sum + mode.fail, 0),
    unavailable: Object.values(report.modeResults).reduce(
      (sum, mode) => sum + mode.unavailable + mode.incomplete,
      0,
    ),
  })}\n`);
  process.exitCode = smokeExitCode(report);
} else {
  throw new Error(`Unknown smoke command: ${command ?? "<missing>"}`);
}
