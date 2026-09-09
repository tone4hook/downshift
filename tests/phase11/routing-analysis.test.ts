import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachValidationResult,
  startAttempt,
  type RunProvenance,
  type RunResult,
  type TrialOutcome,
} from "../../src/artifacts/run-artifacts.js";
import type { UsageSummary } from "../../src/artifacts/usage.js";
import { validateConfig, type LabConfig } from "../../src/config/lab-config.js";
import {
  aggregateExperiment,
  freezePolicy,
  generateExperimentReport,
  loadExperimentRecords,
  replayThresholds,
  renderExperimentMarkdown,
  verifyHeldoutPolicy,
  wilson95,
  type ResolvedTrial,
} from "../../src/evaluation/analysis.js";
import {
  createSmokeManifest,
  type EvaluationMode,
  type SmokeManifest,
  type SmokeTaskId,
} from "../../src/evaluation/smoke.js";
import type { EvaluationRoots } from "../../src/evaluation/task.js";
import type { RoutingDecision } from "../../src/pi/session-routing.js";

const roots: EvaluationRoots = {
  tasksRoot: resolve("tasks"),
  fixturesRoot: resolve("fixtures"),
  evaluatorRoot: resolve("evaluator"),
};
const cleanup: string[] = [];
const fingerprint = {
  value: "a".repeat(64),
  configHash: "b".repeat(64),
  capabilityCardHash: "c".repeat(64),
  modelMetadataHash: "d".repeat(64),
  providerConfigHash: "e".repeat(64),
};
const images = {
  agent: "sha256:agent",
  evaluator: "sha256:evaluator",
  mock: "sha256:mock",
};

async function temporary(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `routing-lab-phase11-${name}-`));
  cleanup.push(path);
  return path;
}

async function createManifest(
  root: string,
  experimentId: string,
  repetitions = 3,
): Promise<{ directory: string; manifest: SmokeManifest; config: LabConfig; configPath: string; configCheckPath: string }> {
  const configPath = join(root, `${experimentId}.config.json`);
  await cp(resolve("config/lab.mock.json"), configPath);
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  const configCheckPath = join(root, `${experimentId}.config-check.json`);
  await writeFile(configCheckPath, JSON.stringify({
    status: "ok",
    authProfile: "mock",
    roles: Object.fromEntries((["classifier", "weak", "strong"] as const).map((role) => [
      role,
      {
        provider: config.models[role].provider,
        model: config.models[role].model,
        storedAuthAvailable: false,
        billing: config.models[role].billing,
      },
    ])),
    policy: { weakThreshold: 0.75, capabilityCardHash: fingerprint.capabilityCardHash },
    fingerprint,
  }));
  const created = await createSmokeManifest({
    roots,
    resultsRoot: root,
    configPath,
    configCheckPath,
    experimentId,
    evidenceKind: "mock",
    suite: "dev",
    seed: 20260905,
    repetitions,
    revision: "f".repeat(40),
    dirty: false,
    images,
  });
  return { ...created, config, configPath, configCheckPath };
}

function summary(tokens: number | null, calls = tokens === null ? 0 : 1): UsageSummary {
  return {
    status: tokens === null ? "unknown" : "complete",
    observedCalls: calls,
    missingCalls: 0,
    inputTokens: tokens === null ? null : Math.max(0, tokens - 2),
    outputTokens: tokens === null ? null : 2,
    cacheReadTokens: tokens === null ? null : 0,
    cacheWriteTokens: tokens === null ? null : 0,
    reasoningTokens: tokens === null ? null : 0,
    totalTokens: tokens,
    semantics: "pi-exclusive-categories",
    missingReasons: tokens === null ? ["usage unavailable"] : [],
  };
}

function provenance(
  mode: EvaluationMode,
  task: SmokeManifest["tasks"][number],
  config: LabConfig,
): RunProvenance {
  return {
    labRevision: "f".repeat(40),
    labDirty: false,
    piVersion: "0.85.0",
    switchyardRevision: "2dd67d76ad12961f92359153e03686773e3e8761",
    agentImageId: images.agent,
    configHash: fingerprint.configHash,
    capabilityCardHash: fingerprint.capabilityCardHash,
    modelMetadataHash: fingerprint.modelMetadataHash,
    providerConfigHash: fingerprint.providerConfigHash,
    authProfile: "mock",
    mode,
    limits: config.execution,
    models: {
      classifier: { provider: "mock", model: "classifier", metadataHash: "1".repeat(64) },
      weak: { provider: "mock", model: "weak", metadataHash: "2".repeat(64) },
      strong: { provider: "mock", model: "strong", metadataHash: "3".repeat(64) },
    },
    taskHash: task.taskHash,
    sourceHash: task.sourceHash,
    validatorHash: task.validatorHash,
  };
}

function decision(
  id: string,
  selectedTier: "weak" | "strong",
  probability: number | null,
  fallback = false,
): RoutingDecision {
  return {
    schemaVersion: 1,
    projectId: "project",
    piSessionId: `session-${id}`,
    runId: id,
    decisionId: `decision-${id}`,
    mode: "routed",
    selectedTier,
    selectedModel: {
      provider: "mock",
      model: selectedTier,
      providerReportedModelId: selectedTier,
    },
    weakSolveProbability: fallback ? null : probability,
    threshold: 0.75,
    source: fallback ? "classifier-fallback" : "classifier",
    fallbackReason: fallback ? "invalid_verdict" : null,
    classifier: { durationMs: 7, inputTokens: 8, outputTokens: 2 },
    fingerprint,
    authProfile: "mock",
    timestamp: "2026-09-06T00:00:00.000Z",
    missingReasons: fallback ? ["classifier verdict was invalid"] : [],
  };
}

function result(options: {
  id: string;
  mode: EvaluationMode;
  task: SmokeManifest["tasks"][number];
  config: LabConfig;
  outcome: TrialOutcome;
  tier?: "weak" | "strong";
  probability?: number | null;
  fallback?: boolean;
  estimatedCost?: number | null;
  referenceCost?: number | null;
  evidenceKind?: "mock" | "live";
  agentMs?: number | null;
}): RunResult {
  const tier = options.tier ??
    (options.mode === "strong-only" ? "strong" : "weak");
  const routedDecision = options.mode === "routed"
    ? decision(options.id, tier, options.probability ?? 0.8, options.fallback)
    : null;
  const notRun = options.outcome === "unavailable" || options.outcome === "incomplete";
  const validationStatus = notRun
    ? "not-run" as const
    : options.outcome === "pass" ? "pass" as const : "fail" as const;
  const classifier = options.mode === "routed" ? summary(10) : summary(0, 0);
  const coding = summary(20);
  const total = summary((classifier.totalTokens ?? 0) + (coding.totalTokens ?? 0));
  return {
    schemaVersion: 1,
    identity: {
      projectId: "project",
      piSessionId: `session-${options.id}`,
      runId: options.id,
      attemptId: options.id,
      decisionId: routedDecision?.decisionId ?? null,
      experimentId: "unit",
      taskId: options.task.id,
      repetition: 0,
    },
    evidenceKind: options.evidenceKind ?? "mock",
    mode: options.mode,
    decision: routedDecision,
    decisionObservation: routedDecision ? "persisted" : null,
    servedModel: { provider: "mock", model: tier, providerReportedModelId: tier },
    execution: {
      status: options.outcome === "unavailable"
        ? "auth-required"
        : options.outcome === "incomplete" ? "cancelled" : "completed",
      startedAt: "2026-09-06T00:00:00.000Z",
      endedAt: "2026-09-06T00:00:01.000Z",
      errorCategory: options.outcome === "unavailable" ? "authentication" : null,
    },
    validation: {
      status: validationStatus,
      checks: notRun ? [] : [{
        name: "trusted",
        status: validationStatus,
        exitCode: validationStatus === "pass" ? 0 : 1,
        durationMs: 5,
        stdoutArtifact: null,
        stderrArtifact: null,
        reason: null,
      }],
    },
    durationsMs: {
      setup: 3,
      routing: options.mode === "routed" ? 7 : null,
      agent: options.agentMs === undefined ? 20 : options.agentMs,
      validation: notRun ? null : 5,
    },
    usage: { classifier, coding, compaction: summary(0, 0), total },
    costs: {
      classifier: {
        billing: "subscription",
        currency: null,
        pricingAsOf: null,
        estimatedCostUsd: options.estimatedCost === undefined ? null : options.estimatedCost,
        referenceCostUsd: 0.01,
        missingReasons: ["subscription billing"],
      },
      coding: {
        billing: "subscription",
        currency: null,
        pricingAsOf: null,
        estimatedCostUsd: options.estimatedCost === undefined ? null : options.estimatedCost,
        referenceCostUsd: 0.02,
        missingReasons: ["subscription billing"],
      },
      totalEstimatedCostUsd: options.estimatedCost === undefined ? null : options.estimatedCost,
      totalReferenceCostUsd: options.referenceCost === undefined ? 0.03 : options.referenceCost,
    },
    provenance: provenance(options.mode, options.task, options.config),
    artifacts: { events: "events.jsonl", patch: "patch.diff" },
    missingReasons: [],
  };
}

function trial(
  taskId: SmokeTaskId,
  repetition: number,
  mode: EvaluationMode,
  run: RunResult | null,
  physicalAttempts: RunResult[] = run ? [run] : [],
): ResolvedTrial {
  return {
    trialId: `${taskId}-r${repetition + 1}-${mode}`,
    taskId,
    repetition,
    mode,
    outcome: run
      ? run.execution.status === "auth-required"
        ? "unavailable"
        : run.execution.status === "cancelled"
          ? "incomplete"
          : run.validation.status === "pass" ? "pass" : "fail"
      : "incomplete",
    result: run,
    physicalAttempts,
    incompletePhysicalAttempts: 0,
  };
}

afterEach(async () => {
  for (const path of cleanup.splice(0).reverse()) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("Phase 11 routing analysis", () => {
  it("implements every primary category, disagreement flag, denominator, and null-cost rule", async () => {
    const root = await temporary("categories");
    const { manifest, config } = await createManifest(root, "unit-categories", 3);
    const tasks = manifest.tasks;
    const cases: Array<{
      weak: TrialOutcome;
      strong: TrialOutcome;
      routed: TrialOutcome;
      tier: "weak" | "strong";
      fallback?: boolean;
    }> = [
      { weak: "pass", strong: "pass", routed: "pass", tier: "weak" },
      { weak: "fail", strong: "pass", routed: "fail", tier: "weak" },
      { weak: "fail", strong: "fail", routed: "fail", tier: "weak" },
      { weak: "fail", strong: "pass", routed: "pass", tier: "strong" },
      { weak: "pass", strong: "pass", routed: "pass", tier: "strong" },
      { weak: "pass", strong: "fail", routed: "fail", tier: "strong" },
      { weak: "fail", strong: "fail", routed: "fail", tier: "strong" },
      { weak: "unavailable", strong: "pass", routed: "unavailable", tier: "strong", fallback: true },
    ];
    const records: ResolvedTrial[] = [];
    cases.forEach((entry, index) => {
      const task = tasks[index % tasks.length]!;
      const repetition = Math.floor(index / tasks.length);
      records.push(
        trial(task.id, repetition, "weak-only", result({
          id: `w-${index}`, mode: "weak-only", task, config, outcome: entry.weak,
        })),
        trial(task.id, repetition, "strong-only", result({
          id: `s-${index}`, mode: "strong-only", task, config, outcome: entry.strong,
        })),
        trial(task.id, repetition, "routed", result({
          id: `r-${index}`,
          mode: "routed",
          task,
          config,
          outcome: entry.routed,
          tier: entry.tier,
          probability: entry.tier === "weak" ? 0.8 : 0.4,
          fallback: entry.fallback ?? false,
        })),
      );
    });
    const report = aggregateExperiment(manifest, records);
    for (const category of [
      "correct-efficiency",
      "under-route",
      "unresolved-weak-failure",
      "correct-capability",
      "over-route",
      "missed-weak-success",
      "unresolved-strong-failure",
      "incomplete-comparison",
    ] as const) {
      expect(report.categories.counts[category]).toBe(1);
    }
    expect(report.categories.underRouteRate).toMatchObject({ numerator: 1, denominator: 3 });
    expect(report.categories.overRouteRate).toMatchObject({ numerator: 1, denominator: 4 });
    expect(report.baselineContingency.weakPassStrongFail).toBe(1);
    expect(report.flags.bothBaselinesFailed).toBe(2);
    expect(report.flags.classifierFallback).toBe(1);
    expect(report.costSavings.value).toBeNull();
    expect(report.spend.totalExperimentEstimatedCostUsd).toBeNull();
    expect(report.spend.totalExperimentReferenceCostUsd).toBeGreaterThan(0);
    expect(report.calibration.samples).toBe(7);
    expect(report.calibration.excludedFallback).toBe(1);
    expect(report.qualityDifference.distinctTasks).toBe(6);
    expect(report.qualityDifference.bootstrapValidResamples).toBe(2_000);
  });

  it("uses exact Wilson arithmetic, keeps repeated attempts in cost, and rejects mixed evidence", async () => {
    expect(wilson95(5, 10)).toEqual({
      lower: expect.closeTo(0.23658959361548731, 12),
      upper: expect.closeTo(0.7634104063845126, 12),
    });
    const root = await temporary("cost");
    const { manifest, config } = await createManifest(root, "unit-cost", 1);
    const task = manifest.tasks[0]!;
    const weak = result({ id: "weak", mode: "weak-only", task, config, outcome: "pass", estimatedCost: 1 });
    const strongFirst = result({ id: "strong-a", mode: "strong-only", task, config, outcome: "unavailable", estimatedCost: 2 });
    const strongFinal = result({ id: "strong-b", mode: "strong-only", task, config, outcome: "pass", estimatedCost: 3 });
    const routed = result({ id: "routed", mode: "routed", task, config, outcome: "pass", tier: "weak", estimatedCost: 2 });
    const records = [
      trial(task.id, 0, "weak-only", weak),
      trial(task.id, 0, "strong-only", strongFinal, [strongFirst, strongFinal]),
      trial(task.id, 0, "routed", routed),
    ];
    const report = aggregateExperiment(manifest, records);
    expect(report.costSavings).toMatchObject({ pairs: 1, omittedPairs: 0, value: 0.6 });
    expect(report.spend.totalExperimentEstimatedCostUsd).toBe(8);
    const mixed = structuredClone(records);
    mixed[0]!.result!.evidenceKind = "live";
    expect(() => aggregateExperiment(manifest, mixed)).toThrow(/Mixed evidence/);
  });

  it("replays equality to weak, preserves fallback, and sanitizes Markdown and terminal controls", async () => {
    const root = await temporary("replay");
    const { manifest, config } = await createManifest(root, "unit-replay", 1);
    const task = manifest.tasks[0]!;
    manifest.tasks[0]!.publicPrompt = "unsafe | cell\nnext\u001b[31m";
    const records = [
      trial(task.id, 0, "weak-only", result({
        id: "weak", mode: "weak-only", task, config, outcome: "pass", estimatedCost: 1,
      })),
      trial(task.id, 0, "strong-only", result({
        id: "strong", mode: "strong-only", task, config, outcome: "fail", estimatedCost: 2,
      })),
      trial(task.id, 0, "routed", result({
        id: "routed", mode: "routed", task, config, outcome: "pass", tier: "weak",
        probability: 0.75, estimatedCost: 0.5,
      })),
    ];
    const replay = replayThresholds(manifest, records);
    expect(replay.rows.find(({ threshold }) => threshold === 0.75)).toMatchObject({
      weakSelections: 1,
      pass: 1,
    });
    const fallbackRecords = structuredClone(records);
    fallbackRecords[2]!.result!.decision = decision("fallback", "strong", null, true);
    const fallbackReplay = replayThresholds(manifest, fallbackRecords);
    expect(fallbackReplay.rows.every((row) => row.fallbackSelections === 1)).toBe(true);
    const markdown = renderExperimentMarkdown(aggregateExperiment(manifest, records));
    expect(markdown).toContain("unsafe \\| cell next [31m");
    expect(markdown).not.toContain("\u001b");
  });

  it("freezes immutable development provenance and rejects changed held-out inputs", async () => {
    const root = await temporary("policy");
    const created = await createManifest(root, "policy-source", 1);
    await populateExperiment(created);
    const policy = await freezePolicy(created.directory, 0.75, "2026-09-06T00:00:00.000Z");
    expect(policy.development.evidenceKind).toBe("mock");
    await expect(freezePolicy(created.directory, 0.75)).resolves.toMatchObject({
      policyId: policy.policyId,
      createdAt: "2026-09-06T00:00:00.000Z",
    });
    await expect(verifyHeldoutPolicy({
      policyPath: join(created.directory, "policy.json"),
      configPath: created.configPath,
      configCheckPath: created.configCheckPath,
    })).resolves.toMatchObject({ policyId: policy.policyId });
    const changedConfig = JSON.parse(await readFile(created.configPath, "utf8"));
    changedConfig.routing.weakThreshold = 0.8;
    await writeFile(created.configPath, JSON.stringify(changedConfig));
    await expect(verifyHeldoutPolicy({
      policyPath: join(created.directory, "policy.json"),
      configPath: created.configPath,
      configCheckPath: created.configCheckPath,
    })).rejects.toThrow(/fingerprint, profile, roles, or threshold/);
    await expect(freezePolicy(created.directory, 0.8)).rejects.toThrow(/immutable/);
  });

  it("produces the reusable synthetic dev acceptance artifact", async () => {
    const resultsRoot = resolve("results");
    await mkdir(resultsRoot, { recursive: true });
    const directory = join(resultsRoot, "phase11-synthetic-dev");
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}-threshold-replay`, { recursive: true, force: true });
    const created = await createManifest(resultsRoot, "phase11-synthetic-dev", 3);
    await populateExperiment(created);
    const report = await generateExperimentReport(created.directory);
    expect(report.counts).toMatchObject({ planned: 54, evaluated: 54, incomplete: 0 });
    expect(report.calibration.samples).toBe(15);
    expect(report.calibration.excludedFallback).toBe(3);
    expect((await loadExperimentRecords(created.directory)).trials).toHaveLength(54);
  }, 30_000);
});

async function populateExperiment(created: {
  directory: string;
  manifest: SmokeManifest;
  config: LabConfig;
}): Promise<void> {
  for (const scheduled of created.manifest.schedule) {
    const task = created.manifest.tasks.find(({ id }) => id === scheduled.taskId)!;
    const taskNumber = Number.parseInt(task.id.slice(0, 2), 10);
    const weakPass = taskNumber % 3 !== 0;
    const strongPass = taskNumber !== 6;
    const fallback = scheduled.mode === "routed" && task.id === "06-money-total";
    const probability = taskNumber % 2 === 0 ? 0.6 : 0.85;
    const tier = scheduled.mode === "strong-only" || fallback || probability < 0.75
      ? "strong"
      : "weak";
    const pass = scheduled.mode === "weak-only"
      ? weakPass
      : scheduled.mode === "strong-only"
        ? strongPass
        : tier === "weak" ? weakPass : strongPass;
    const store = await startAttempt({
      stateRoot: created.directory,
      collection: "attempts",
      identity: {
        projectId: "project",
        piSessionId: `session-${scheduled.attemptId}`,
        runId: scheduled.attemptId,
        attemptId: scheduled.attemptId,
        experimentId: created.manifest.experimentId,
        taskId: scheduled.taskId,
        repetition: scheduled.repetition,
      },
      evidenceKind: "mock",
      mode: scheduled.mode,
      provenance: provenance(scheduled.mode, task, created.config),
    });
    const routedDecision = scheduled.mode === "routed"
      ? decision(scheduled.attemptId, tier, fallback ? null : probability, fallback)
      : null;
    const classifier = scheduled.mode === "routed" ? summary(10) : summary(0, 0);
    const coding = summary(20);
    const total = summary((classifier.totalTokens ?? 0) + (coding.totalTokens ?? 0));
    const reference = scheduled.mode === "routed" ? 0.03 : 0.02;
    const roleCost = {
      billing: "subscription" as const,
      currency: null,
      pricingAsOf: null,
      estimatedCostUsd: null,
      referenceCostUsd: reference,
      missingReasons: ["subscription billing has no measured dollar spend"],
    };
    await store.finalizeAttempt({
      executionStatus: "completed",
      decision: routedDecision,
      decisionObservation: routedDecision ? "persisted" : null,
      servedModel: { provider: "mock", model: tier, providerReportedModelId: tier },
      routingDurationMs: routedDecision ? 7 : null,
      agentDurationMs: 20 + taskNumber,
      usage: { classifier, coding, compaction: summary(0, 0), total },
      costs: {
        classifier: roleCost,
        coding: roleCost,
        totalEstimatedCostUsd: null,
        totalReferenceCostUsd: reference,
      },
    });
    await attachValidationResult(store.directory, {
      status: pass ? "pass" : "fail",
      checks: [{
        name: "trusted",
        status: pass ? "pass" : "fail",
        exitCode: pass ? 0 : 1,
        durationMs: 5,
        stdoutArtifact: "validation/trusted.stdout.txt",
        stderrArtifact: "validation/trusted.stderr.txt",
        reason: null,
      }],
      durationMs: 5,
    });
  }
}
