import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectAttempt } from "../../src/evaluation/collect-attempt.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachValidationResult,
  startAttempt,
  type RunProvenance,
} from "../../src/artifacts/run-artifacts.js";
import { calculateRoleCost, UsageLedger } from "../../src/artifacts/usage.js";
import { validateConfig, type LabConfig } from "../../src/config/lab-config.js";
import {
  conservativeTrialCostBound,
  createEvaluationPlan,
  createSmokeManifest,
  generateSmokeReport,
  nextEvaluationAction,
  smokeSchedule,
  type EvaluationSuite,
  verifyResumeCompatibility,
} from "../../src/evaluation/smoke.js";
import type { EvaluationRoots } from "../../src/evaluation/task.js";

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
  const path = await mkdtemp(join(tmpdir(), `routing-lab-phase09-${name}-`));
  cleanup.push(path);
  return path;
}

async function setup(root: string, config = resolve("config/lab.mock.json")) {
  const configPath = join(root, "lab.json");
  await cp(config, configPath);
  const configCheckPath = join(root, "config-check.json");
  const parsed = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  await writeFile(
    configCheckPath,
    JSON.stringify({
      status: "ok",
      authProfile: parsed.authProfile,
      roles: Object.fromEntries(
        (["classifier", "weak", "strong"] as const).map((role) => [
          role,
          {
            provider: parsed.models[role].provider,
            model: parsed.models[role].model,
            storedAuthAvailable: false,
            billing: parsed.models[role].billing,
          },
        ]),
      ),
      policy: {
        weakThreshold: parsed.routing.weakThreshold,
        capabilityCardHash: fingerprint.capabilityCardHash,
      },
      fingerprint,
    }),
  );
  return { configPath, configCheckPath, config: parsed };
}

async function manifest(
  root: string,
  repetitions = 3,
  config?: string,
  suite: EvaluationSuite = "smoke",
) {
  const files = await setup(root, config);
  const created = await createSmokeManifest({
    roots,
    resultsRoot: root,
    configPath: files.configPath,
    configCheckPath: files.configCheckPath,
    experimentId: "phase09-test",
    evidenceKind: "mock",
    suite,
    seed: 20260905,
    repetitions,
    maxCostUsd: null,
    revision: "f".repeat(40),
    dirty: false,
    images,
  });
  return { ...created, ...files };
}

function provenance(
  config: LabConfig,
  mode: "weak-only" | "strong-only" | "routed",
  task: { taskHash: string; sourceHash: string; validatorHash: string },
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

afterEach(async () => {
  for (const path of cleanup.splice(0).reverse()) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("Phase 09 evaluation runner", () => {
  it("collects only local regular artifacts and rejects links", async () => {
    const root = await temporary("collection");
    const source = join(root, "scratch", "attempts", "one");
    const destination = join(root, "experiment", "attempts", "one");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "events.jsonl"), "partial evidence\n");
    await writeFile(join(source, "manifest.json"), "forged manifest");
    await collectAttempt(source, destination);
    expect(await readFile(join(destination, "events.jsonl"), "utf8")).toBe("partial evidence\n");
    await expect(readFile(join(destination, "manifest.json"))).rejects.toThrow();
    await symlink(join(source, "manifest.json"), join(source, "run.json"));
    await expect(collectAttempt(source, destination)).rejects.toThrow();
  });

  it("restores recorded configuration and profile without relying on the checkout default", async () => {
    const root = await temporary("restore-config");
    const created = await manifest(root, 1);
    const output = join(root, "restored.json");
    const execute = promisify(execFile);
    const args = ["--import", "tsx", resolve("src/evaluation/smoke-cli.ts"), "resume-config",
      join(created.directory, "manifest.json"), output, "mock"];
    const result = await execute(process.execPath, args);
    expect(result.stdout).toBe(`auth-profile:${created.manifest.authProfile}\n`);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(created.manifest.configuration);
    await expect(execute(process.execPath, [...args.slice(0, -1), "live"])).rejects.toThrow();
  });
  it("commits the Mulberry32 three-repetition reference schedule", () => {
    const schedule = smokeSchedule(20260905, 3);
    expect(schedule).toHaveLength(27);
    expect(schedule.map(({ taskId, repetition, mode }) => [taskId, repetition, mode])).toEqual([
      ["03-stable-filter", 0, "routed"],
      ["03-stable-filter", 0, "weak-only"],
      ["03-stable-filter", 0, "strong-only"],
      ["02-create-validation", 2, "weak-only"],
      ["02-create-validation", 2, "strong-only"],
      ["02-create-validation", 2, "routed"],
      ["02-create-validation", 1, "weak-only"],
      ["02-create-validation", 1, "routed"],
      ["02-create-validation", 1, "strong-only"],
      ["01-null-summary", 2, "routed"],
      ["01-null-summary", 2, "weak-only"],
      ["01-null-summary", 2, "strong-only"],
      ["01-null-summary", 1, "routed"],
      ["01-null-summary", 1, "weak-only"],
      ["01-null-summary", 1, "strong-only"],
      ["03-stable-filter", 2, "strong-only"],
      ["03-stable-filter", 2, "routed"],
      ["03-stable-filter", 2, "weak-only"],
      ["01-null-summary", 0, "strong-only"],
      ["01-null-summary", 0, "weak-only"],
      ["01-null-summary", 0, "routed"],
      ["02-create-validation", 0, "weak-only"],
      ["02-create-validation", 0, "strong-only"],
      ["02-create-validation", 0, "routed"],
      ["03-stable-filter", 1, "routed"],
      ["03-stable-filter", 1, "strong-only"],
      ["03-stable-filter", 1, "weak-only"],
    ]);
    expect(new Set(schedule.flatMap(({ attemptIds }) => attemptIds)).size).toBe(27 * 16);
    expect(schedule.every(({ seed }) => seed === 20260905)).toBe(true);
  });

  it("plans populated suites without calls", async () => {
    const config = validateConfig(
      JSON.parse(await readFile(resolve("config/lab.mock.json"), "utf8")),
    );
    expect(createEvaluationPlan(config, {
      suite: "smoke",
      repetitions: 3,
      seed: 20260905,
    })).toMatchObject({
      available: true,
      taskCount: 3,
      codingTrials: 27,
      expectedClassifierCalls: 9,
      billing: { monetaryLimitSupported: false },
    });
    expect(createEvaluationPlan(config, {
      suite: "heldout",
      repetitions: 3,
      seed: 20260905,
    })).toMatchObject({
      available: true,
      taskCount: 12,
      codingTrials: 108,
      expectedClassifierCalls: 36,
    });
    const root = await temporary("heldout-manifest");
    const created = await manifest(root, 3, undefined, "heldout");
    expect(created.manifest.suite).toBe("heldout");
    expect(created.manifest.tasks).toHaveLength(12);
    expect(created.manifest.schedule).toHaveLength(108);
  });

  it("requires bounded per-token pricing before monetary dispatch", async () => {
    const mock = validateConfig(
      JSON.parse(await readFile(resolve("config/lab.mock.json"), "utf8")),
    );
    expect(() => conservativeTrialCostBound(mock, "routed")).toThrow(
      /classifier uses subscription billing/,
    );
    const perToken = validateConfig({
      ...mock,
      models: Object.fromEntries(
        (["classifier", "weak", "strong"] as const).map((role, index) => [
          role,
          {
            provider: "mock",
            model: role,
            billing: "per-token",
            pricing: {
              inputPerMillion: index + 1,
              outputPerMillion: index + 2,
              cacheReadPerMillion: index + 1,
              cacheWritePerMillion: index + 1,
              currency: "USD",
              asOf: "2026-09-06",
            },
          },
        ]),
      ),
    });
    expect(conservativeTrialCostBound(perToken, "routed")).toBeGreaterThan(
      conservativeTrialCostBound(perToken, "weak-only"),
    );
    const root = await temporary("budget");
    const configSource = join(root, "per-token.json");
    await writeFile(configSource, `${JSON.stringify(perToken)}\n`);
    const files = await setup(root, configSource);
    await expect(createSmokeManifest({
      roots,
      resultsRoot: root,
      configPath: files.configPath,
      configCheckPath: files.configCheckPath,
      experimentId: "insufficient-budget",
      evidenceKind: "mock",
      seed: 20260905,
      repetitions: 1,
      maxCostUsd: 0.000001,
      revision: null,
      dirty: null,
      images,
    })).rejects.toThrow(/Insufficient monetary budget before first trial/);

    const created = await createSmokeManifest({
      roots,
      resultsRoot: root,
      configPath: files.configPath,
      configCheckPath: files.configCheckPath,
      experimentId: "unknown-usage",
      evidenceKind: "mock",
      seed: 20260905,
      repetitions: 1,
      maxCostUsd: 100,
      revision: null,
      dirty: null,
      images,
    });
    const first = await nextEvaluationAction(created.directory);
    if (first.action !== "run") throw new Error("expected a runnable budget attempt");
    const task = created.manifest.tasks.find(({ id }) => id === first.job.taskId)!;
    await startAttempt({
      stateRoot: created.directory,
      collection: "attempts",
      identity: {
        projectId: "project",
        piSessionId: "partial-stream",
        runId: first.job.attemptId,
        attemptId: first.job.attemptId,
        experimentId: created.manifest.experimentId,
        taskId: first.job.taskId,
        repetition: first.job.repetition,
      },
      evidenceKind: "mock",
      mode: first.job.mode,
      provenance: provenance(perToken, first.job.mode, task),
    });
    await expect(nextEvaluationAction(created.directory)).rejects.toThrow(
      /billed usage became unknown/,
    );
  });

  it("preserves interrupted attempts and never retries a terminal capability failure", async () => {
    const root = await temporary("resume");
    const created = await manifest(root, 1);
    const first = await nextEvaluationAction(created.directory);
    expect(first.action).toBe("run");
    if (first.action !== "run") throw new Error("expected a runnable attempt");
    const task = created.manifest.tasks.find(({ id }) => id === first.job.taskId)!;
    for (let index = 0; index < 4; index++) {
      const job = first.job.attemptIds[index]!;
      const store = await startAttempt({
        stateRoot: created.directory,
        collection: "attempts",
        identity: {
          projectId: "project",
          piSessionId: `session-${index}`,
          runId: job,
          attemptId: job,
          experimentId: created.manifest.experimentId,
          taskId: first.job.taskId,
          repetition: first.job.repetition,
        },
        evidenceKind: "mock",
        mode: first.job.mode,
        provenance: provenance(created.config, first.job.mode, task),
      });
      if (index === 0) {
        await store.appendEvent("model-call", {
          action: "start",
          role: "classifier",
          callId: "classifier-call",
        });
      } else if (index === 1) {
        await store.appendEvent("model-call", {
          action: "start",
          role: "coding",
          callId: "coding-call",
        });
      } else if (index === 2) {
        await store.appendEvent("tool", {
          action: "start",
          toolCallId: "tool-call",
          toolName: "write",
        });
      } else {
        await store.appendEvent("lifecycle", {
          action: "agent-settled",
          reason: "interrupted before validation",
        });
      }
    }
    const recovery = await nextEvaluationAction(created.directory);
    expect(recovery).toMatchObject({
      action: "run",
      job: {
        attemptId: first.job.attemptIds[4],
        previousAttemptId: first.job.attemptIds[3],
      },
    });
    if (recovery.action !== "run") throw new Error("expected a recovery attempt");
    const usage = new UsageLedger().summaries();
    const unknownCost = calculateRoleCost(created.config.models.weak, usage.coding);
    const store = await startAttempt({
      stateRoot: created.directory,
      collection: "attempts",
      identity: {
        projectId: "project",
        piSessionId: "terminal-session",
        runId: recovery.job.attemptId,
        attemptId: recovery.job.attemptId,
        experimentId: created.manifest.experimentId,
        taskId: recovery.job.taskId,
        repetition: recovery.job.repetition,
      },
      evidenceKind: "mock",
      mode: recovery.job.mode,
      provenance: provenance(created.config, recovery.job.mode, task),
    });
    await store.finalizeAttempt({
      executionStatus: "completed",
      decision: null,
      decisionObservation: null,
      servedModel: { provider: "mock", model: "weak", providerReportedModelId: "weak" },
      routingDurationMs: null,
      agentDurationMs: 1,
      usage,
      costs: {
        classifier: unknownCost,
        coding: unknownCost,
        totalEstimatedCostUsd: null,
        totalReferenceCostUsd: null,
      },
    });
    await attachValidationResult(store.directory, {
      status: "fail",
      checks: [{
        name: "trusted",
        status: "fail",
        exitCode: 1,
        durationMs: 1,
        stdoutArtifact: null,
        stderrArtifact: null,
        reason: "capability failure",
      }],
      durationMs: 1,
    });
    const next = await nextEvaluationAction(created.directory);
    expect(next.action).toBe("run");
    if (next.action !== "run") throw new Error("expected the next logical trial");
    expect(next.job.trialId).not.toBe(first.job.trialId);
    expect(next.job.attemptId).toBe(next.job.attemptIds[0]);
    const report = await generateSmokeReport(created.directory);
    expect(report.trials).toHaveLength(1);
    expect(report.trials[0]?.trialId).toBe(first.job.trialId);
  });

  it("resumes validation in place and rejects changed fingerprints before dispatch", async () => {
    const root = await temporary("validation");
    const created = await manifest(root, 1);
    const first = await nextEvaluationAction(created.directory);
    if (first.action !== "run") throw new Error("expected a runnable attempt");
    const task = created.manifest.tasks.find(({ id }) => id === first.job.taskId)!;
    const usage = new UsageLedger().summaries();
    const unknownCost = calculateRoleCost(created.config.models.weak, usage.coding);
    const store = await startAttempt({
      stateRoot: created.directory,
      collection: "attempts",
      identity: {
        projectId: "project",
        piSessionId: "validation-session",
        runId: first.job.attemptId,
        attemptId: first.job.attemptId,
        experimentId: created.manifest.experimentId,
        taskId: first.job.taskId,
        repetition: first.job.repetition,
      },
      evidenceKind: "mock",
      mode: first.job.mode,
      provenance: provenance(created.config, first.job.mode, task),
    });
    await store.finalizeAttempt({
      executionStatus: "completed",
      decision: null,
      decisionObservation: null,
      servedModel: { provider: "mock", model: "weak", providerReportedModelId: "weak" },
      routingDurationMs: null,
      agentDurationMs: 1,
      usage,
      costs: {
        classifier: unknownCost,
        coding: unknownCost,
        totalEstimatedCostUsd: null,
        totalReferenceCostUsd: null,
      },
    });
    await writeFile(join(store.directory, "submission.json"), "{}\n");
    expect(await nextEvaluationAction(created.directory)).toMatchObject({
      action: "validate",
      job: { attemptId: first.job.attemptId },
    });
    await expect(verifyResumeCompatibility({
      experimentDirectory: created.directory,
      roots,
      configPath: created.configPath,
      configCheckPath: created.configCheckPath,
      evidenceKind: "mock",
      images,
      lockPaths: {
        pnpm: resolve("pnpm-lock.yaml"),
        cargo: resolve("rust/switchyard-bridge/Cargo.lock"),
      },
    })).resolves.toMatchObject({ experimentId: "phase09-test" });
    const changed = JSON.parse(await readFile(created.configCheckPath, "utf8"));
    changed.fingerprint.value = "9".repeat(64);
    await writeFile(created.configCheckPath, JSON.stringify(changed));
    await expect(verifyResumeCompatibility({
      experimentDirectory: created.directory,
      roots,
      configPath: created.configPath,
      configCheckPath: created.configCheckPath,
      evidenceKind: "mock",
      images,
      lockPaths: {
        pnpm: resolve("pnpm-lock.yaml"),
        cargo: resolve("rust/switchyard-bridge/Cargo.lock"),
      },
    })).rejects.toThrow(/fingerprint/);
  });
});
