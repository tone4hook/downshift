import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachValidationResult,
  startAttempt,
  type RunProvenance,
} from "../../src/artifacts/run-artifacts.js";
import { calculateRoleCost, UsageLedger } from "../../src/artifacts/usage.js";
import type { RoutingDecision } from "../../src/pi/session-routing.js";
import {
  createSmokeManifest,
  generateSmokeReport,
  smokeExitCode,
  smokeSchedule,
} from "../../src/evaluation/smoke.js";
import { loadTaskDefinition, type EvaluationRoots } from "../../src/evaluation/task.js";
import { verifyReference } from "../../src/evaluation/validator.js";

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

async function temporary(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `routing-lab-phase08-${name}-`));
  cleanup.push(path);
  return path;
}

async function createManifest(root: string) {
  const configPath = join(root, "lab.mock.json");
  await cp(resolve("config/lab.mock.json"), configPath);
  const configCheckPath = join(root, "config-check.json");
  await writeFile(configCheckPath, JSON.stringify({
    status: "ok",
    authProfile: "mock",
    roles: {
      classifier: {
        provider: "mock",
        model: "classifier",
        storedAuthAvailable: false,
        billing: "subscription",
      },
      weak: {
        provider: "mock",
        model: "weak",
        storedAuthAvailable: false,
        billing: "unknown",
      },
      strong: {
        provider: "mock",
        model: "strong",
        storedAuthAvailable: false,
        billing: "unknown",
      },
    },
    policy: { weakThreshold: 0.75, capabilityCardHash: fingerprint.capabilityCardHash },
    fingerprint,
  }));
  return createSmokeManifest({
    roots,
    resultsRoot: root,
    configPath,
    configCheckPath,
    experimentId: "smoke-test",
    evidenceKind: "mock",
    revision: "f".repeat(40),
    dirty: false,
    images: {
      agent: "sha256:agent",
      evaluator: "sha256:evaluator",
      mock: "sha256:mock",
    },
  });
}

function provenance(
  mode: "weak-only" | "strong-only" | "routed",
  task: { taskHash: string; sourceHash: string; validatorHash: string },
): RunProvenance {
  return {
    labRevision: "f".repeat(40),
    labDirty: false,
    piVersion: "0.85.0",
    switchyardRevision: "2dd67d76ad12961f92359153e03686773e3e8761",
    agentImageId: "sha256:agent",
    configHash: fingerprint.configHash,
    capabilityCardHash: fingerprint.capabilityCardHash,
    modelMetadataHash: fingerprint.modelMetadataHash,
    providerConfigHash: fingerprint.providerConfigHash,
    authProfile: "mock",
    mode,
    limits: {
      maxAgentTurns: 40,
      timeoutSeconds: 900,
      requestTimeoutSeconds: 120,
      validationTimeoutSeconds: 120,
      contextTokenCap: 32768,
      maxOutputTokens: 4096,
      thinking: "off",
    },
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

function routedDecision(
  attemptId: string,
  selectedTier: "weak" | "strong",
  fallback: boolean,
): RoutingDecision {
  return {
    schemaVersion: 1,
    projectId: "project",
    piSessionId: `session-${attemptId}`,
    runId: attemptId,
    decisionId: `decision-${attemptId}`,
    mode: "routed",
    selectedTier,
    selectedModel: {
      provider: "mock",
      model: selectedTier,
      providerReportedModelId: null,
    },
    weakSolveProbability: fallback ? null : 0.9,
    threshold: 0.75,
    source: fallback ? "classifier-fallback" : "classifier",
    fallbackReason: fallback ? "invalid_verdict" : null,
    classifier: {
      durationMs: 1,
      inputTokens: 12,
      outputTokens: 8,
    },
    fingerprint,
    authProfile: "mock",
    timestamp: "2026-09-06T00:00:00.000Z",
    missingReasons: fallback ? ["classifier verdict was invalid"] : [],
  };
}

afterEach(async () => {
  for (const path of cleanup.splice(0).reverse()) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("Phase 08 smoke benchmark", () => {
  it(
    "verifies all three immutable baseline/reference/incomplete fixture gates",
    async () => {
      const root = await temporary("fixtures");
      for (const id of ["01-null-summary", "02-create-validation", "03-stable-filter"]) {
        const task = await loadTaskDefinition(id, roots);
        const result = await verifyReference(task, join(root, id));
        expect(result.baseline.status).toBe("fail");
        expect(result.reference.status).toBe("pass");
        expect(result.incomplete.status).toBe("fail");
      }
    },
    15_000,
  );

  it("creates the fixed seeded nine-trial schedule before execution", async () => {
    expect(smokeSchedule()).toEqual([
      expect.objectContaining({ taskId: "02-create-validation", mode: "routed" }),
      expect.objectContaining({ taskId: "02-create-validation", mode: "strong-only" }),
      expect.objectContaining({ taskId: "02-create-validation", mode: "weak-only" }),
      expect.objectContaining({ taskId: "01-null-summary", mode: "routed" }),
      expect.objectContaining({ taskId: "01-null-summary", mode: "strong-only" }),
      expect.objectContaining({ taskId: "01-null-summary", mode: "weak-only" }),
      expect.objectContaining({ taskId: "03-stable-filter", mode: "weak-only" }),
      expect.objectContaining({ taskId: "03-stable-filter", mode: "routed" }),
      expect.objectContaining({ taskId: "03-stable-filter", mode: "strong-only" }),
    ]);
    const root = await temporary("manifest");
    const { manifest } = await createManifest(root);
    expect(manifest.schedule).toHaveLength(9);
    expect(new Set(manifest.schedule.map(({ attemptId }) => attemptId))).toHaveLength(9);
    expect(manifest.evidenceKind).toBe("mock");
    expect(manifest.tasks.map(({ id }) => id)).toEqual([
      "01-null-summary",
      "02-create-validation",
      "03-stable-filter",
    ]);
  });

  it("regenerates matching JSON and Markdown with failure and fallback evidence", async () => {
    const root = await temporary("report");
    const { directory, manifest } = await createManifest(root);
    const unknownUsage = new UsageLedger().summaries();
    const unknownCost = calculateRoleCost(
      { provider: "mock", model: "weak", billing: "unknown" },
      unknownUsage.coding,
    );
    for (const scheduled of manifest.schedule) {
      const task = manifest.tasks.find(({ id }) => id === scheduled.taskId)!;
      const store = await startAttempt({
        stateRoot: directory,
        collection: "attempts",
        identity: {
          projectId: "project",
          piSessionId: `session-${scheduled.attemptId}`,
          runId: scheduled.attemptId,
          attemptId: scheduled.attemptId,
          experimentId: manifest.experimentId,
          taskId: scheduled.taskId,
          repetition: 0,
        },
        evidenceKind: "mock",
        mode: scheduled.mode,
        provenance: provenance(scheduled.mode, task),
      });
      const isFallback = scheduled.mode === "routed" && scheduled.taskId === "03-stable-filter";
      const selectedTier =
        scheduled.mode === "strong-only" || isFallback ? "strong" : "weak";
      const decision =
        scheduled.mode === "routed"
          ? routedDecision(scheduled.attemptId, selectedTier, isFallback)
          : null;
      await store.finalizeAttempt({
        executionStatus: "completed",
        decision,
        decisionObservation: decision ? "persisted" : null,
        servedModel: {
          provider: "mock",
          model: selectedTier,
          providerReportedModelId: selectedTier,
        },
        routingDurationMs: decision ? 1 : null,
        agentDurationMs: 2,
        usage: unknownUsage,
        costs: {
          classifier: unknownCost,
          coding: unknownCost,
          totalEstimatedCostUsd: null,
          totalReferenceCostUsd: null,
        },
      });
      const shouldFail =
        scheduled.taskId === "02-create-validation" && selectedTier === "weak";
      await attachValidationResult(store.directory, {
        status: shouldFail ? "fail" : "pass",
        checks: [{
          name: "trusted",
          status: shouldFail ? "fail" : "pass",
          exitCode: shouldFail ? 1 : 0,
          durationMs: 1,
          stdoutArtifact: "trusted.stdout.txt",
          stderrArtifact: "trusted.stderr.txt",
          reason: null,
        }],
        durationMs: 1,
      });
    }
    const report = await generateSmokeReport(directory);
    expect(report).toMatchObject({
      evidenceKind: "mock",
      planned: 9,
      evaluated: 9,
      missing: 0,
      routedDecisions: { weak: 2, strong: 1, fallback: 1, total: 3 },
      totalEstimatedCostUsd: null,
    });
    expect(report.modeResults["weak-only"].fail).toBe(1);
    expect(report.modeResults.routed.fail).toBe(1);
    expect(smokeExitCode(report)).toBe(1);
    const json = JSON.parse(await readFile(join(directory, "experiment.json"), "utf8"));
    const markdown = await readFile(join(directory, "experiment.md"), "utf8");
    expect(json.planned).toBe(9);
    expect(markdown).toContain("planned 9; evaluated 9; missing 0");
    expect(markdown).toContain("fallback 1");
    expect(markdown).toContain("Unknown or subscription billing remains null");
  });

  it("requires explicit live authentication and never upgrades mock config by credential presence", async () => {
    const root = await temporary("live");
    const configPath = join(root, "lab.mock.json");
    await cp(resolve("config/lab.mock.json"), configPath);
    const configCheckPath = join(root, "config-check.json");
    await writeFile(configCheckPath, JSON.stringify({
      status: "ok",
      authProfile: "mock",
      roles: {
        classifier: { provider: "mock", model: "classifier", storedAuthAvailable: false, billing: "subscription" },
        weak: { provider: "mock", model: "weak", storedAuthAvailable: false, billing: "unknown" },
        strong: { provider: "mock", model: "strong", storedAuthAvailable: false, billing: "unknown" },
      },
      policy: { weakThreshold: 0.75, capabilityCardHash: fingerprint.capabilityCardHash },
      fingerprint,
    }));
    await expect(createSmokeManifest({
      roots,
      resultsRoot: root,
      configPath,
      configCheckPath,
      experimentId: "live-rejected",
      evidenceKind: "live",
      revision: null,
      dirty: null,
      images: { agent: "agent", evaluator: "evaluator", mock: null },
    })).rejects.toThrow(/requires Pi authentication/);
  });
});
