import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readAttempt, redactSensitive, startAttempt, type RunProvenance } from "../../src/artifacts/run-artifacts.js";
import {
  calculateRoleCost,
  normalizeUsage,
  UsageLedger,
  type UsageSummary,
} from "../../src/artifacts/usage.js";
import { SwitchyardBridgeClient } from "../../src/bridge/client.js";
import {
  createContainerRuntime,
  type ContainerRuntime,
} from "../../src/container/session-runtime.js";
import type { LabConfig } from "../../src/config/lab-config.js";
import {
  startMockPiServer,
  type MockPiServer,
} from "../phase01/mock-pi-provider.js";

const bridgeExecutable = resolve("rust/switchyard-bridge/target/debug/switchyard-bridge");
const cleanup: Array<() => Promise<void>> = [];
const execute = promisify(execFile);

function config(models: Partial<LabConfig["models"]> = {}): LabConfig {
  return {
    schemaVersion: 1,
    authProfile: "mock",
    models: {
      classifier: {
        provider: "mock",
        model: "classifier",
        billing: "per-token",
        pricing: {
          inputPerMillion: 1,
          outputPerMillion: 2,
          cacheReadPerMillion: 0.1,
          cacheWritePerMillion: 1.25,
          currency: "USD",
          asOf: "2026-09-06",
        },
        ...models.classifier,
      },
      weak: {
        provider: "mock",
        model: "weak",
        billing: "per-token",
        pricing: {
          inputPerMillion: 3,
          outputPerMillion: 4,
          cacheReadPerMillion: 0.3,
          cacheWritePerMillion: 3.75,
          currency: "USD",
          asOf: "2026-09-06",
        },
        ...models.weak,
      },
      strong: {
        provider: "mock",
        model: "strong",
        billing: "unknown",
        ...models.strong,
      },
    },
    routing: {
      weakThreshold: 0.75,
      weakCapabilityDescription: "Deterministic fake provider for Phase 06.",
    },
    execution: {
      maxAgentTurns: 40,
      timeoutSeconds: 30,
      requestTimeoutSeconds: 10,
      validationTimeoutSeconds: 10,
      contextTokenCap: 32768,
      maxOutputTokens: 4096,
      thinking: "off",
    },
  };
}

function classifier(probability: number | string = 0.9) {
  return {
    type: "text" as const,
    text: JSON.stringify({
      crux: "bounded phase 06 task",
      primary_rule: "SUP-1",
      capability_boundary: "supported",
      p_solve: probability,
    }),
  };
}

function provenance(): RunProvenance {
  const hash = "a".repeat(64);
  return {
    labRevision: "b".repeat(40),
    labDirty: false,
    piVersion: "0.85.0",
    switchyardRevision: "c".repeat(40),
    agentImageId: "sha256:test",
    configHash: hash,
    capabilityCardHash: hash,
    modelMetadataHash: hash,
    providerConfigHash: hash,
    authProfile: "mock",
    mode: "routed",
    limits: config().execution,
    models: {
      classifier: { provider: "mock", model: "classifier", metadataHash: hash },
      weak: { provider: "mock", model: "weak", metadataHash: hash },
      strong: { provider: "mock", model: "strong", metadataHash: hash },
    },
    taskHash: null,
    sourceHash: null,
    validatorHash: null,
  };
}

function emptyUsage(): Record<"classifier" | "coding" | "compaction" | "total", UsageSummary> {
  const ledger = new UsageLedger();
  return ledger.summaries();
}

function emptyCosts() {
  const usage = emptyUsage();
  return {
    classifier: calculateRoleCost(
      { provider: "mock", model: "classifier", billing: "unknown" },
      usage.classifier,
    ),
    coding: calculateRoleCost(
      { provider: "mock", model: "weak", billing: "unknown" },
      usage.coding,
    ),
    totalEstimatedCostUsd: null,
    totalReferenceCostUsd: null,
  };
}

async function rawStore(root: string, runId = "run-1") {
  return startAttempt({
    stateRoot: root,
    identity: {
      projectId: "project",
      piSessionId: "session",
      runId,
      attemptId: runId,
      experimentId: null,
      taskId: null,
      repetition: null,
    },
    evidenceKind: "mock",
    mode: "routed",
    provenance: provenance(),
  });
}

interface Harness {
  root: string;
  mock: MockPiServer;
  bridge: SwitchyardBridgeClient;
  runtime: ContainerRuntime;
}

async function createHarness(options: {
  mock?: MockPiServer;
  root?: string;
  mode?: "weak-only" | "strong-only" | "routed";
  tokenLifetimeMs?: number;
  modelConfig?: Partial<LabConfig["models"]>;
} = {}): Promise<Harness> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "routing-lab-phase06-")));
  if (!options.root) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mock = options.mock ?? (await startMockPiServer({
    ...(options.tokenLifetimeMs === undefined ? {} : { tokenLifetimeMs: options.tokenLifetimeMs }),
  }));
  if (!options.mock) cleanup.push(() => mock.close());
  const profile = join(root, "profile");
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(state, { recursive: true }),
    mkdir(join(workspace, "node_modules"), { recursive: true }),
  ]);
  await writeFile(join(workspace, "phase06.txt"), "");
  await execute("git", ["init", "--quiet", workspace]);
  await execute("git", ["-C", workspace, "add", "phase06.txt"]);
  await execute(
    "git",
    ["-C", workspace, "-c", "user.name=Phase Six", "-c", "user.email=phase06@example.invalid", "commit", "--quiet", "-m", "fixture"],
  );
  const configPath = join(root, "lab.json");
  await writeFile(configPath, `${JSON.stringify(config(options.modelConfig))}\n`);
  const bridge = await SwitchyardBridgeClient.start(bridgeExecutable);
  cleanup.push(() => bridge.dispose());
  const runtime = await createContainerRuntime(
    {
      LAB_AUTH_PROFILE: "mock",
      PI_PROFILE_ROOT: profile,
      LAB_PROJECT_STATE: state,
      LAB_WORKSPACE: workspace,
      LAB_PROJECT_ID: "project-phase06",
      LAB_INVOCATION_ID: `run-${Date.now()}-${Math.random()}`,
      LAB_CONFIG_PATH: configPath,
      LAB_MODE: options.mode ?? "routed",
      LAB_MOCK_BASE_URL: mock.baseUrl,
      LAB_REVISION: "d".repeat(40),
      LAB_DIRTY: "false",
      LAB_AGENT_IMAGE_ID: "sha256:phase06-test",
      SWITCHYARD_BRIDGE: bridgeExecutable,
    },
    { bridge },
  );
  cleanup.push(() => runtime.sessionRuntime.dispose());
  const bind = (session: ContainerRuntime["sessionRuntime"]["session"]) =>
    session.bindExtensions({
      mode: "json",
      onError: (error) => {
        if (runtime.routing) runtime.routing.lastError = error.error;
      },
    });
  runtime.sessionRuntime.setRebindSession(bind);
  await bind(runtime.sessionRuntime.session);
  return { root, mock, bridge, runtime };
}

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("Phase 06 run artifacts", () => {
  it("records a real mock Pi/Switchyard run with reconciled usage, cost, aliases, and provenance", async () => {
    const harness = await createHarness({ tokenLifetimeMs: -1 });
    harness.mock.enqueue(
      classifier(),
      {
        type: "tool",
        name: "write",
        arguments: { path: "phase06.txt", content: "artifact evidence\n" },
      },
      {
        type: "text",
        text: "done",
        inputTokens: 17,
        outputTokens: 5,
        responseModel: "provider-native-weak-alias",
      },
    );
    await harness.runtime.sessionRuntime.session.prompt("Create the requested artifact.");
    expect(harness.runtime.routing?.lastError).toBeNull();
    await harness.runtime.artifacts!.captureWorkspacePatch(harness.runtime.paths.workspace);
    const result = await harness.runtime.artifacts!.finalize();
    const read = await harness.runtime.artifacts!.store.readAttempt();

    expect(result).toMatchObject({
      evidenceKind: "mock",
      mode: "routed",
      decision: {
        selectedTier: "weak",
        source: "classifier",
        weakSolveProbability: 0.9,
      },
      servedModel: {
        provider: "mock",
        model: "weak",
        providerReportedModelId: "provider-native-weak-alias",
      },
      execution: { status: "completed" },
      validation: { status: "not-run", checks: [] },
      provenance: {
        labRevision: "d".repeat(40),
        labDirty: false,
        piVersion: "0.85.0",
        switchyardRevision: "2dd67d76ad12961f92359153e03686773e3e8761",
      },
    });
    expect(result.usage.classifier).toMatchObject({
      status: "complete",
      observedCalls: 1,
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    });
    expect(result.usage.coding).toMatchObject({
      status: "complete",
      observedCalls: 2,
      inputTokens: 30,
      outputTokens: 14,
      totalTokens: 44,
    });
    expect(result.costs.classifier.estimatedCostUsd).toBeCloseTo(0.000025);
    expect(result.costs.coding.estimatedCostUsd).toBeCloseTo(0.000146);
    expect(result.costs.totalEstimatedCostUsd).toBeCloseTo(0.000171);
    expect(harness.mock.state.refreshCount).toBe(1);
    expect(result.provenance.configHash).toBe(result.decision?.fingerprint.configHash);
    expect(await readFile(harness.runtime.artifacts!.store.patchPath, "utf8")).toContain(
      "+artifact evidence",
    );
    expect(read.status).toBe("finalized");
    expect(read.events.map((event) => event.sequence)).toEqual(
      read.events.map((_, index) => index + 1),
    );
    expect(read.events.filter((event) => event.kind === "routing" && event.payload.action === "decision-recorded"))
      .toHaveLength(1);
    expect(read.events).toContainEqual(expect.objectContaining({
      kind: "auth",
      payload: { action: "refresh", outcome: "success" },
    }));
    expect((await stat(harness.runtime.artifacts!.store.resultPath)).mode & 0o777).toBe(0o600);
    expect((await stat(harness.runtime.artifacts!.store.directory)).mode & 0o777).toBe(0o700);
  });

  it("keeps Switchyard-rejected raw probability out of validated decision evidence", async () => {
    const harness = await createHarness();
    harness.mock.enqueue(classifier(".80"), { type: "text", text: "fallback coding" });
    await harness.runtime.sessionRuntime.session.prompt("Use invalid classifier evidence.");
    const result = await harness.runtime.artifacts!.finalize();
    expect(result.decision).toMatchObject({
      source: "classifier-fallback",
      selectedTier: "strong",
      weakSolveProbability: null,
      fallbackReason: "invalid_verdict",
    });
  });

  it("rotates to a distinct finalized artifact when Pi starts a new session", async () => {
    const harness = await createHarness();
    harness.mock.enqueue(classifier(), { type: "text", text: "first" });
    await harness.runtime.sessionRuntime.session.prompt("First session.");
    const first = harness.runtime.artifacts!;
    const firstSessionId = harness.runtime.sessionRuntime.session.sessionId;

    await harness.runtime.sessionRuntime.newSession();
    harness.mock.enqueue(classifier(), { type: "text", text: "second" });
    await harness.runtime.sessionRuntime.session.prompt("Second session.");
    const second = harness.runtime.artifacts!;
    const secondSessionId = harness.runtime.sessionRuntime.session.sessionId;

    expect(secondSessionId).not.toBe(firstSessionId);
    expect(second.store.directory).not.toBe(first.store.directory);
    expect((await first.store.readAttempt()).status).toBe("finalized");
    const secondResult = await second.finalize();
    expect(secondResult.identity.piSessionId).toBe(secondSessionId);
    expect(secondResult.identity.runId).toBe(secondResult.decision?.runId);
    expect(secondResult.decision?.decisionId).not.toBe(
      (await first.store.readAttempt()).result?.decision?.decisionId,
    );
  });

  it("marks quota/provider failures unavailable without a decision or strong rescue", async () => {
    const harness = await createHarness();
    harness.mock.enqueue({ type: "error", status: 429, message: "quota exhausted" });
    await harness.runtime.sessionRuntime.session.prompt("Do not convert quota to capability failure.");
    const message = harness.runtime.routing?.lastError;
    expect(message).toMatch(/quota|bridge_model_error/i);
    const result = await harness.runtime.artifacts!.finalize(new Error(message!));
    expect(result.execution.status).toBe("rate-limited");
    expect(result.validation.status).toBe("not-run");
    expect(result.decision).toBeNull();
    expect(harness.mock.state.inferenceModels).toEqual(["classifier"]);
  });

  it("records revoked authentication as unavailable without changing the decision", async () => {
    const harness = await createHarness();
    harness.mock.enqueue(classifier(), { type: "text", text: "selected" });
    await harness.runtime.sessionRuntime.session.prompt("Select the weak model.");
    const decisionId = (
      await harness.runtime.routing!.store.read(harness.runtime.sessionRuntime.session.sessionId)
    )!.decisionId;
    harness.mock.revoke();
    await harness.runtime.sessionRuntime.session.prompt("Do not route around revoked auth.");
    const result = await harness.runtime.artifacts!.finalize();
    expect(result.execution.status).toBe("auth-required");
    expect(result.decision?.decisionId).toBe(decisionId);
    expect(harness.mock.state.inferenceModels).not.toContain("strong");
  });

  it("stops invalid measurement when Pi's served model violates the fixed selection", async () => {
    const harness = await createHarness({ mode: "weak-only" });
    harness.mock.enqueue({ type: "text", text: "wrong model", servedModel: "strong" });
    await harness.runtime.sessionRuntime.session.prompt("Detect the served identity mismatch.");
    const result = await harness.runtime.artifacts!.finalize(
      new Error(harness.runtime.routing?.lastError ?? "model identity mismatch"),
    );
    expect(result.execution.status).toBe("harness-error");
    expect(result.execution.errorCategory).toMatch(/harness|model-identity/);
  });

  it("normalizes cached usage without double counting and rejects conflicting duplicate delivery", () => {
    const ledger = new UsageLedger();
    const usage = normalizeUsage({
      input: 10,
      output: 5,
      cacheRead: 7,
      cacheWrite: 3,
      reasoning: 2,
      totalTokens: 25,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(ledger.record("call-1", "coding", usage)).toBe(true);
    expect(ledger.record("call-1", "coding", usage)).toBe(false);
    expect(() =>
      ledger.record("call-1", "coding", { ...usage, outputTokens: 6 }),
    ).toThrow(/Conflicting duplicate/);
    expect(ledger.summaries().total).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      totalTokens: 25,
      semantics: "pi-exclusive-categories",
    });
  });

  it("preserves partial usage and keeps subscription and unknown estimated cost null", () => {
    const ledger = new UsageLedger();
    ledger.record("known-partial", "coding", normalizeUsage({
      input: 4,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }), false);
    ledger.record("absent", "coding", null, false);
    const summary = ledger.summaries().coding;
    expect(summary).toMatchObject({
      status: "partial",
      observedCalls: 1,
      missingCalls: 1,
      totalTokens: 5,
    });
    const subscription = calculateRoleCost(
      { provider: "mock", model: "weak", billing: "subscription" },
      summary,
      { inputPerMillion: 0, outputPerMillion: 0 },
    );
    expect(subscription.estimatedCostUsd).toBeNull();
    expect(subscription.referenceCostUsd).toBeNull();
    const unknown = calculateRoleCost(
      { provider: "mock", model: "weak", billing: "unknown" },
      summary,
    );
    expect(unknown.estimatedCostUsd).toBeNull();
    expect(unknown.referenceCostUsd).toBeNull();
    expect(unknown.missingReasons).toContain("Pi reference pricing is unavailable");
  });

  it("redacts authentication material and privacy sentinel values from persisted/shareable records", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-lab-phase06-redaction-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await rawStore(root);
    await store.appendEvent("error", {
      category: "provider",
      message: "Authorization: Bearer PHASE06_PRIVATE_SENTINEL",
    });
    await store.finalizeAttempt({
      executionStatus: "provider-error",
      errorCategory: "provider",
      decision: null,
      decisionObservation: null,
      servedModel: null,
      routingDurationMs: null,
      agentDurationMs: null,
      usage: emptyUsage(),
      costs: emptyCosts(),
    });
    const persisted = `${await readFile(store.eventsPath, "utf8")}${await readFile(store.resultPath, "utf8")}`;
    expect(persisted).not.toContain("PHASE06_PRIVATE_SENTINEL");
    expect(redactSensitive({
      apiKey: "another-secret",
      nested: { access_token: "PHASE06_PRIVATE_SENTINEL" },
    })).toEqual({
      apiKey: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
    });
  });

  it("recognizes a truncated JSONL tail as incomplete and rejects corrupt finalized records", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-lab-phase06-interrupt-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await rawStore(root);
    await store.appendEvent("startup", {
      mode: "routed",
      evidenceKind: "mock",
      authProfile: "mock",
      configHash: "a".repeat(64),
    });
    await appendFile(store.eventsPath, '{"truncated":');
    const interrupted = await readAttempt(store.directory);
    expect(interrupted).toMatchObject({
      status: "incomplete",
      result: null,
      truncatedTail: true,
    });
    await writeFile(store.resultPath, '{"schemaVersion":1}\n', { mode: 0o600 });
    await expect(readAttempt(store.directory)).rejects.toThrow(/Invalid run result/);
  });

  it("surfaces artifact write failures instead of returning success-shaped evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-lab-phase06-write-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await rawStore(root);
    await rm(store.eventsPath);
    await mkdir(store.eventsPath);
    await expect(store.appendEvent("startup", {
      mode: "routed",
      evidenceKind: "mock",
      authProfile: "mock",
      configHash: "a".repeat(64),
    })).rejects.toThrow();
    await chmod(store.directory, 0o700);
  });

  it("rejects unknown fields in owned event payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-lab-phase06-schema-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await rawStore(root);
    expect(() =>
      store.appendEvent("startup", {
        mode: "routed",
        evidenceKind: "mock",
        authProfile: "mock",
        configHash: "a".repeat(64),
        unexpected: true,
      }),
    ).toThrow(/Invalid run event/);
  });
});

it("preserves a partial streaming failure on the selected identity with unknown usage", async () => {
  const harness = await createHarness();
  harness.mock.enqueue(classifier(), { type: "text", text: "partial output", streamFailure: "connection reset during stream" });
  await harness.runtime.sessionRuntime.session.prompt("Keep streaming failures observable.");
  const result = await harness.runtime.artifacts!.finalize();
  expect(result.execution.status).toBe("provider-error");
  expect(result.decision?.selectedTier).toBe("weak");
  expect(result.usage.coding.status).not.toBe("complete");
  expect(harness.mock.state.inferenceModels).toEqual(["classifier", "weak"]);
});

it("lets Pi handle a failed tool without reclassifying or switching tiers", async () => {
  const harness = await createHarness();
  harness.mock.enqueue(classifier(), { type: "tool", name: "read", arguments: { path: "missing-file.ts" } }, { type: "text", text: "The requested file is absent." });
  await harness.runtime.sessionRuntime.session.prompt("Read missing-file.ts and explain the result.");
  const result = await harness.runtime.artifacts!.finalize();
  expect(result.execution.status).toBe("completed");
  expect(result.validation.status).toBe("not-run");
  expect(harness.runtime.sessionRuntime.session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
  expect(harness.mock.state.inferenceModels).toEqual(["classifier", "weak", "weak"]);
});
