import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachValidationResult,
  classifyTrialOutcome,
  startAttempt,
  type RunProvenance,
} from "../../src/artifacts/run-artifacts.js";
import { calculateRoleCost, UsageLedger } from "../../src/artifacts/usage.js";
import { loadTaskDefinition, type EvaluationRoots, type LoadedTask } from "../../src/evaluation/task.js";
import {
  exportSubmission,
  materializeTask,
  validateSubmissionExport,
} from "../../src/evaluation/workspace.js";
import { validateSubmission, verifyReference } from "../../src/evaluation/validator.js";

const roots: EvaluationRoots = {
  tasksRoot: resolve("tasks"),
  fixturesRoot: resolve("fixtures"),
  evaluatorRoot: resolve("evaluator"),
};
const cleanup: string[] = [];

async function temporary(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `routing-lab-${name}-`));
  cleanup.push(path);
  return path;
}

async function loadedTask(): Promise<LoadedTask> {
  return loadTaskDefinition("phase07-synthetic", roots);
}

async function referenceSubmission(task: LoadedTask, root: string) {
  const workspace = join(root, "workspace");
  await materializeTask(task, workspace);
  await cp(
    join(task.evaluatorDirectory, "reference", "src", "sum-positive.ts"),
    join(workspace, "src", "sum-positive.ts"),
  );
  return exportSubmission(task, workspace, join(root, "export"));
}

function provenance(): RunProvenance {
  const hash = "a".repeat(64);
  return {
    labRevision: "b".repeat(40),
    labDirty: false,
    piVersion: "0.85.0",
    switchyardRevision: "c".repeat(40),
    agentImageId: "sha256:phase07",
    configHash: hash,
    capabilityCardHash: hash,
    modelMetadataHash: hash,
    providerConfigHash: hash,
    authProfile: "mock",
    mode: "weak-only",
    limits: {
      maxAgentTurns: 40,
      timeoutSeconds: 30,
      requestTimeoutSeconds: 10,
      validationTimeoutSeconds: 2,
      contextTokenCap: 32768,
      maxOutputTokens: 4096,
      thinking: "off",
    },
    models: {
      classifier: { provider: "mock", model: "classifier", metadataHash: hash },
      weak: { provider: "mock", model: "weak", metadataHash: hash },
      strong: { provider: "mock", model: "strong", metadataHash: hash },
    },
    taskHash: hash,
    sourceHash: hash,
    validatorHash: hash,
  };
}

async function finalizedAttempt(root: string, status: "completed" | "timeout" | "provider-error" = "completed") {
  const usage = new UsageLedger().summaries();
  const store = await startAttempt({
    stateRoot: root,
    identity: {
      projectId: "project",
      piSessionId: "session",
      runId: "run",
      attemptId: "attempt",
      experimentId: "experiment",
      taskId: "phase07-synthetic",
      repetition: 0,
    },
    evidenceKind: "mock",
    mode: "weak-only",
    provenance: provenance(),
  });
  const unknown = calculateRoleCost(
    { provider: "mock", model: "weak", billing: "unknown" },
    usage.coding,
  );
  await store.finalizeAttempt({
    executionStatus: status,
    errorCategory: status === "completed" ? null : status,
    decision: null,
    decisionObservation: null,
    servedModel: null,
    routingDurationMs: null,
    agentDurationMs: 1,
    usage,
    costs: {
      classifier: unknown,
      coding: unknown,
      totalEstimatedCostUsd: null,
      totalReferenceCostUsd: null,
    },
  });
  return store;
}

function passingValidation() {
  return {
    status: "pass" as const,
    checks: [{
      name: "trusted",
      status: "pass" as const,
      exitCode: 0,
      durationMs: 1,
      stdoutArtifact: "trusted.stdout.txt",
      stderrArtifact: "trusted.stderr.txt",
      reason: null,
    }],
    durationMs: 2,
  };
}

afterEach(async () => {
  for (const path of cleanup.splice(0).reverse()) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("Phase 07 isolated validation", () => {
  it.each(["process.exit(0)", "process.reallyExit(0)"])("rejects premature exit before assertions: %s", async (exit) => {
    const task = await loadedTask();
    const root = await temporary("premature-exit");
    const workspace = join(root, "workspace");
    await materializeTask(task, workspace);
    const source = join(workspace, "src/sum-positive.ts");
    await writeFile(source, `${await readFile(source, "utf8")}\n${exit};\n`);
    const submission = await exportSubmission(task, workspace, join(root, "export"));
    const result = await validateSubmission(task, submission, join(root, "validation"));
    expect(result.status).toBe("fail");
    expect(result.checks.every((check) => check.status === "fail")).toBe(true);
  });
  it.each(["exit", "reallyExit"])("rejects process.%s after a passing hidden test", async (method) => {
    const task = await loadedTask();
    const root = await temporary("partial-exit");
    const workspace = join(root, "workspace");
    await materializeTask(task, workspace);
    await writeFile(join(workspace, "src/sum-positive.ts"), `
      export function sumPositive(values: number[]): number {
        if (values.includes(0.25)) process.${method}(0);
        return values.reduce((sum, value) => value > 0 ? sum + value : sum, 0);
      }
    `);
    const submission = await exportSubmission(task, workspace, join(root, "export"));
    const result = await validateSubmission(task, submission, join(root, "validation"));
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.status)).toEqual(["pass", "fail"]);
  });

  it("verifies immutable fixture and validator hashes through the same evaluator", async () => {
    const task = await loadedTask();
    const root = await temporary("quality");
    const result = await verifyReference(task, root);
    expect(result.baseline.status).toBe("fail");
    expect(result.reference.status).toBe("pass");
    expect(result.incomplete.status).toBe("fail");
    expect(await readFile(join(root, "fixture-quality.json"), "utf8")).toContain('"reference"');
  });

  it("materializes identical fresh workspaces that remain independently writable", async () => {
    const task = await loadedTask();
    const root = await temporary("materialize");
    const first = join(root, "first");
    const second = join(root, "second");
    const firstResult = await materializeTask(task, first);
    const secondResult = await materializeTask(task, second);
    expect(firstResult).toEqual(secondResult);
    await writeFile(join(first, "src", "sum-positive.ts"), "export const changed = true;\n");
    expect(await readFile(join(second, "src", "sum-positive.ts"), "utf8")).toContain("sumPositive");
    expect((await loadedTask()).definition.fixture.hash).toBe(task.definition.fixture.hash);
  });

  it("fails an unchanged agent claim and accepts only the known reference behavior", async () => {
    const task = await loadedTask();
    const root = await temporary("claims");
    const workspace = join(root, "workspace");
    await materializeTask(task, workspace);
    const unchanged = await exportSubmission(task, workspace, join(root, "unchanged-export"));
    expect(
      (await validateSubmission(task, unchanged, join(root, "unchanged-validation"))).status,
    ).toBe("fail");
    const reference = await referenceSubmission(task, join(root, "reference"));
    expect(reference.status).toBe("accepted");
    expect(
      (await validateSubmission(task, reference, join(root, "reference-validation"))).status,
    ).toBe("pass");
  });

  it("rejects protected edits, forbidden deletion, symlinks, and secret-bearing files", async () => {
    const task = await loadedTask();
    const root = await temporary("policy");

    const tampered = join(root, "tampered");
    await materializeTask(task, tampered);
    await writeFile(join(tampered, "package.json"), '{"scripts":{"test":"true"}}\n');
    expect((await exportSubmission(task, tampered, join(root, "tampered-export"))).status).toBe(
      "rejected",
    );

    const deleted = join(root, "deleted");
    await materializeTask(task, deleted);
    await rm(join(deleted, "test", "public.test.mjs"));
    expect((await exportSubmission(task, deleted, join(root, "deleted-export"))).violations).toContain(
      "protected or non-editable path changed: test/public.test.mjs",
    );

    const linked = join(root, "linked");
    await materializeTask(task, linked);
    await symlink("/etc/passwd", join(linked, "src", "escape.ts"));
    await expect(exportSubmission(task, linked, join(root, "linked-export"))).rejects.toThrow(
      /forbidden symlink/,
    );

    const secret = join(root, "secret");
    await materializeTask(task, secret);
    await writeFile(join(secret, "auth.json"), '{"token":"PHASE07_FAKE_TOKEN_SENTINEL"}\n');
    const rejected = await exportSubmission(task, secret, join(root, "secret-export"));
    expect(rejected.status).toBe("rejected");
    expect(await readFile(join(root, "secret-export", "submission.json"), "utf8")).not.toContain(
      "PHASE07_FAKE_TOKEN_SENTINEL",
    );
  });

  it("permits declared source additions and rejects path traversal in imported manifests", async () => {
    const task = await loadedTask();
    const root = await temporary("paths");
    const workspace = join(root, "workspace");
    await materializeTask(task, workspace);
    await writeFile(join(workspace, "src", "helper.ts"), "export const helper = true;\n");
    const submission = await exportSubmission(task, workspace, join(root, "export"));
    expect(submission).toMatchObject({
      status: "accepted",
      changes: [expect.objectContaining({ path: "src/helper.ts", kind: "add" })],
    });
    expect(() =>
      validateSubmissionExport({
        ...submission,
        changes: [{
          path: "../escape.ts",
          kind: "add",
          sha256: "a".repeat(64),
          bytesBase64: "",
        }],
      }),
    ).toThrow(/Invalid submission export|Unsafe relative path/);
  });

  it("classifies runaway submitted code as FAIL and validator startup failure as ERROR", async () => {
    const task = await loadedTask();
    const root = await temporary("limits");
    const submission = await referenceSubmission(task, join(root, "reference"));
    const evaluator = join(root, "evaluator");
    await cp(task.evaluatorDirectory, evaluator, { recursive: true });

    const runawayTask: LoadedTask = {
      ...task,
      evaluatorDirectory: evaluator,
      definition: {
        ...task.definition,
        limits: { ...task.definition.limits, validationTimeoutSeconds: 1 },
      },
    };
    await writeFile(
      join(evaluator, "validator.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: task.definition.id,
        hiddenChecks: [{ name: "runaway", argv: ["node", "-e", "setInterval(()=>{},1000)"] }],
        referenceDirectory: "reference",
        incompleteDirectory: "incomplete",
      }),
    );
    const runaway = await validateSubmission(runawayTask, submission, join(root, "runaway"));
    expect(runaway.status).toBe("fail");
    expect(runaway.checks.at(-1)).toMatchObject({ name: "runaway", reason: "validation timeout" });

    await writeFile(
      join(evaluator, "validator.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: task.definition.id,
        hiddenChecks: [{ name: "broken-validator", argv: ["phase07-command-does-not-exist"] }],
        referenceDirectory: "reference",
        incompleteDirectory: "incomplete",
      }),
    );
    const broken = await validateSubmission(runawayTask, submission, join(root, "broken"));
    expect(broken.status).toBe("error");
    expect(broken.checks.at(-1)?.status).toBe("error");
  });

  it("surfaces unavailable dependency setup before any validation", async () => {
    const task = await loadedTask();
    const root = await temporary("setup");
    const broken: LoadedTask = {
      ...task,
      definition: {
        ...task.definition,
        setupArgv: ["phase07-package-manager-does-not-exist"],
      },
    };
    await expect(materializeTask(broken, join(root, "workspace"))).rejects.toThrow(
      /dependency setup failed to start/,
    );
  });

  it("keeps cancelled execution incomplete and attaches independent results atomically", async () => {
    const root = await temporary("attachment");
    const store = await finalizedAttempt(root);
    const attached = await attachValidationResult(store.directory, passingValidation());
    expect(attached.validation.status).toBe("pass");
    expect(classifyTrialOutcome(attached)).toBe("pass");
    await expect(
      access(join(store.directory, "run.json"), constants.R_OK),
    ).resolves.toBeUndefined();

    const timeoutStore = await finalizedAttempt(await temporary("timeout"), "timeout");
    const timeout = await attachValidationResult(timeoutStore.directory, passingValidation());
    expect(classifyTrialOutcome(timeout)).toBe("fail");

    const providerStore = await finalizedAttempt(await temporary("provider"), "provider-error");
    const provider = await attachValidationResult(providerStore.directory, passingValidation());
    expect(classifyTrialOutcome(provider)).toBe("unavailable");
  });

  it("does not run checks for a cancelled agent", async () => {
    const task = await loadedTask();
    const root = await temporary("cancelled");
    const submission = await referenceSubmission(task, join(root, "reference"));
    const result = await validateSubmission(
      task,
      submission,
      join(root, "validation"),
      "cancelled",
    );
    expect(result).toEqual({ status: "not-run", checks: [], durationMs: null });
  });
});
