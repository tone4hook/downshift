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

export const roots: EvaluationRoots = {
  tasksRoot: resolve("tasks"),
  fixturesRoot: resolve("fixtures"),
  evaluatorRoot: resolve("evaluator"),
};
const cleanup: string[] = [];
export const fingerprint = {
  value: "a".repeat(64),
  configHash: "b".repeat(64),
  capabilityCardHash: "c".repeat(64),
  modelMetadataHash: "d".repeat(64),
  providerConfigHash: "e".repeat(64),
};
export const images = {
  agent: "sha256:" + "1".repeat(64),
  evaluator: "sha256:" + "2".repeat(64),
  mock: "sha256:" + "3".repeat(64),
};

async function temporary(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `routing-lab-phase11-${name}-`));
  cleanup.push(path);
  return path;
}

export async function createManifest(
  root: string,
  experimentId: string,
  repetitions = 3,
  corpus?: "core" | "harness" | "combined",
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
    ...(corpus ? { corpus, sourceContentHash: "a".repeat(64) } : {}),
    seed: 20260905,
    repetitions,
    revision: "f".repeat(40),
    dirty: false,
    images,
  });
  return { ...created, config, configPath, configCheckPath };
}

export function summary(tokens: number | null, calls = tokens === null ? 0 : 1): UsageSummary {
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

export function decision(
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

export function result(options: {
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

export function trial(
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

export async function populateExperiment(created: {
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
    const tier = scheduled.mode === "weak-only" ? "weak" : scheduled.mode === "strong-only" || fallback || probability < 0.75 ? "strong" : "weak";
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
