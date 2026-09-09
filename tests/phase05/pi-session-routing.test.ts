import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { SwitchyardBridgeClient } from "../../src/bridge/client.js";
import {
  createContainerRuntime,
  type ContainerRuntime,
} from "../../src/container/session-runtime.js";
import type { LabConfig } from "../../src/config/lab-config.js";
import { ROUTING_DECISION_ENTRY } from "../../src/pi/session-routing.js";
import { classifyTrialOutcome } from "../../src/artifacts/run-artifacts.js";
import { registerMockPiProvider, startMockPiServer, type MockPiServer } from "../phase01/mock-pi-provider.js";

const bridgeExecutable = resolve("rust/switchyard-bridge/target/debug/switchyard-bridge");
const cleanup: Array<() => Promise<void>> = [];

function classifier(probability = 0.9) {
  return {
    type: "text" as const,
    text: JSON.stringify({
      crux: "bounded phase 05 task",
      primary_rule: "SUP-1",
      capability_boundary: "supported",
      p_solve: probability,
    }),
  };
}

function config(
  threshold = 0.75,
  execution: Partial<LabConfig["execution"]> = {},
): LabConfig {
  return {
    schemaVersion: 1,
    authProfile: "mock",
    models: {
      classifier: { provider: "mock", model: "classifier", billing: "subscription" },
      weak: { provider: "mock", model: "weak", billing: "unknown" },
      strong: { provider: "mock", model: "strong", billing: "unknown" },
    },
    routing: {
      weakThreshold: threshold,
      weakCapabilityDescription: "Deterministic fake provider for phase 05.",
    },
    execution: {
      maxAgentTurns: 40,
      timeoutSeconds: 30,
      requestTimeoutSeconds: 10,
      validationTimeoutSeconds: 10,
      contextTokenCap: 32768,
      maxOutputTokens: 4096,
      thinking: "off",
      ...execution,
    },
  };
}

interface Harness {
  root: string;
  environment: NodeJS.ProcessEnv;
  mock: MockPiServer;
  bridge: SwitchyardBridgeClient;
  runtime: ContainerRuntime;
  configPath: string;
}

function appendCompactionHistory(session: ContainerRuntime["sessionRuntime"]["session"]): void {
  for (let index = 0; index < 20; index += 1) {
    session.sessionManager.appendMessage({
      role: "user",
      content: `context-${index} ${"word ".repeat(2_000)}`,
      timestamp: Date.now(),
    });
    session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `response-${index}` }],
      api: "mock-phase01",
      provider: "mock",
      model: "weak",
      usage: {
        input: 2_000,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2_001,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }
}

async function createHarness(options: {
  mode?: "weak-only" | "strong-only" | "routed";
  tokenLifetimeMs?: number;
  inferenceDelayMs?: number;
  root?: string;
  mock?: MockPiServer;
  resume?: string;
  threshold?: number;
  authProfile?: string;
  execution?: Partial<LabConfig["execution"]>;
} = {}): Promise<Harness> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "routing-lab-phase05-")));
  if (!options.root) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mock =
    options.mock ??
    (await startMockPiServer({
      ...(options.tokenLifetimeMs === undefined ? {} : { tokenLifetimeMs: options.tokenLifetimeMs }),
      ...(options.inferenceDelayMs === undefined
        ? {}
        : { inferenceDelayMs: options.inferenceDelayMs }),
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
  const configPath = join(root, `lab-${options.threshold ?? 0.75}.json`);
  await writeFile(
    configPath,
    `${JSON.stringify(config(options.threshold, options.execution))}\n`,
  );
  const environment: NodeJS.ProcessEnv = {
    LAB_AUTH_PROFILE: options.authProfile ?? "mock",
    PI_PROFILE_ROOT: profile,
    LAB_PROJECT_STATE: state,
    LAB_WORKSPACE: workspace,
    LAB_PROJECT_ID: "project-phase05",
    LAB_INVOCATION_ID: `run-${Date.now()}-${Math.random()}`,
    LAB_CONFIG_PATH: configPath,
    LAB_MODE: options.mode ?? "routed",
    LAB_MOCK_BASE_URL: mock.baseUrl,
    SWITCHYARD_BRIDGE: bridgeExecutable,
    ...(options.resume ? { LAB_RESUME_SESSION_ID: options.resume } : {}),
  };
  const bridge = await SwitchyardBridgeClient.start(bridgeExecutable);
  cleanup.push(() => bridge.dispose());
  const runtime = await createContainerRuntime(environment, { bridge });
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
  return { root, environment, mock, bridge, runtime, configPath };
}

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("phase 05 Pi session routing", () => {
  it("records exhausted turns as a capability failure without dispatching another generation", async () => {
    const harness = await createHarness({ mode: "weak-only", execution: { maxAgentTurns: 1 } });
    harness.mock.enqueue({ type: "tool", name: "write", arguments: { path: "a.txt", content: "a" } });
    await harness.runtime.sessionRuntime.session.prompt("Write a.txt.");
    const result = await harness.runtime.artifacts!.finalize(harness.runtime.routing!.limitError ?? undefined);
    expect(result.execution.status).toBe("budget-exhausted");
    expect(classifyTrialOutcome(result)).toBe("fail");
    expect(harness.mock.state.inferenceModels).toEqual(["weak"]);
  });

  it("preserves wall timeout through Pi's tool abort instead of recording cancellation", async () => {
    const harness = await createHarness({ mode: "weak-only", execution: { timeoutSeconds: 1, requestTimeoutSeconds: 1 } });
    harness.mock.enqueue({ type: "tool", name: "bash", arguments: { command: "sleep 10" } });
    await harness.runtime.sessionRuntime.session.prompt("Run the tool.");
    const result = await harness.runtime.artifacts!.finalize();
    expect(result.execution.status).toBe("timeout");
    expect(classifyTrialOutcome(result)).toBe("fail");
    expect(harness.mock.state.inferenceModels).toEqual(["weak"]);
  });

  it("includes classification in end-to-end agent latency", async () => {
    const harness = await createHarness({ inferenceDelayMs: 200 });
    harness.mock.enqueue(classifier(), { type: "text", text: "done" });
    await harness.runtime.sessionRuntime.session.prompt("Complete the task.");
    const result = await harness.runtime.artifacts!.finalize();
    expect(result.durationsMs.routing).toBeGreaterThanOrEqual(180);
    expect(result.durationsMs.agent! - result.durationsMs.routing!).toBeGreaterThanOrEqual(180);
  });

  it("records classifier request timeout as capability FAIL before the wall deadline", async () => {
    const harness = await createHarness({ inferenceDelayMs: 1500, execution: { requestTimeoutSeconds: 1 } });
    harness.mock.enqueue(classifier());
    await harness.runtime.sessionRuntime.session.prompt("Complete the task.");
    const result = await harness.runtime.artifacts!.finalize();
    expect(result.execution.status).toBe("timeout");
    expect(classifyTrialOutcome(result)).toBe("fail");
    // The fake server records requests after its delay, even when Pi aborts first.
    await expect.poll(() => harness.mock.state.inferenceModels).toEqual(["classifier"]);
  });
  it("persists one Switchyard decision before native Pi coding and restores it after restart", async () => {
    const harness = await createHarness({ tokenLifetimeMs: -1 });
    const session = harness.runtime.sessionRuntime.session;
    harness.mock.enqueue(
      classifier(),
      {
        type: "tool",
        name: "write",
        arguments: { path: "phase05.txt", content: "routed through Pi\n" },
      },
      { type: "text", text: "done" },
    );

    await session.prompt("Create phase05.txt.");
    const sessionId = session.sessionId;
    const decision = await harness.runtime.routing!.store.read(sessionId);
    expect(decision).toMatchObject({
      mode: "routed",
      selectedTier: "weak",
      source: "classifier",
      weakSolveProbability: 0.9,
    });
    expect(session.model).toMatchObject({ provider: "mock", id: "weak" });
    expect(harness.mock.state.inferenceModels).toEqual(["classifier", "weak", "weak"]);
    expect(await readFile(join(harness.root, "workspace", "phase05.txt"), "utf8")).toBe(
      "routed through Pi\n",
    );
    expect(
      session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === ROUTING_DECISION_ENTRY),
    ).toHaveLength(1);

    await session.setModel(harness.runtime.routing!.roles.strong);
    expect(session.model).toMatchObject({ provider: "mock", id: "weak" });
    await session.cycleModel();
    expect(session.model).toMatchObject({ provider: "mock", id: "weak" });

    harness.mock.enqueue({ type: "text", text: "follow-up" });
    await session.prompt("Confirm the edit.");
    expect(harness.mock.state.inferenceModels).toEqual(["classifier", "weak", "weak", "weak"]);
    expect(harness.mock.state.refreshCount).toBe(1);

    await harness.runtime.sessionRuntime.dispose();
    await harness.bridge.dispose();
    const resumed = await createHarness({
      root: harness.root,
      mock: harness.mock,
      resume: sessionId,
    });
    expect(resumed.runtime.sessionRuntime.session.model).toMatchObject({ provider: "mock", id: "weak" });
    resumed.mock.enqueue({ type: "text", text: "resumed" });
    await resumed.runtime.sessionRuntime.session.prompt("Continue after restart.");
    expect(resumed.mock.state.inferenceModels.filter((model) => model === "classifier")).toHaveLength(1);
  });

  it("keeps queued follow-ups and compaction on the selected model", async () => {
    const harness = await createHarness({ inferenceDelayMs: 200 });
    const session = harness.runtime.sessionRuntime.session;
    harness.mock.enqueue(
      classifier(),
      { type: "text", text: "first response" },
      { type: "text", text: "queued response" },
      { type: "text", text: "compacted summary" },
    );
    const running = session.prompt("Initial task.");
    await expect.poll(() => session.isStreaming, { timeout: 5_000 }).toBe(true);
    await session.followUp("Queued follow-up.");
    await running;
    await session.waitForIdle();
    expect(harness.mock.state.inferenceModels).toEqual(["classifier", "weak", "weak"]);

    appendCompactionHistory(session);
    await session.compact("Keep the routing decision context.");
    expect(harness.mock.state.inferenceModels).toEqual(["classifier", "weak", "weak", "weak"]);
    expect(harness.mock.state.inferenceModels.filter((model) => model === "classifier")).toHaveLength(1);
    expect(session.model).toMatchObject({ provider: "mock", id: "weak" });
  });

  it("does not reclassify or escalate when native Pi compaction fails", async () => {
    const harness = await createHarness();
    const session = harness.runtime.sessionRuntime.session;
    harness.mock.enqueue(
      classifier(),
      { type: "text", text: "initial" },
      { type: "error", status: 500, message: "compaction failed" },
    );
    await session.prompt("Create context.");
    appendCompactionHistory(session);
    await expect(session.compact("Summarize without changing models.")).rejects.toThrow();
    expect(harness.mock.state.inferenceModels).toEqual(["classifier", "weak", "weak"]);
    expect(session.model).toMatchObject({ provider: "mock", id: "weak" });
  });

  it("gives new and forked Pi sessions fresh decisions while tree state remains session-local", async () => {
    const harness = await createHarness();
    harness.mock.enqueue(classifier(), { type: "text", text: "first" });
    await harness.runtime.sessionRuntime.session.prompt("First task.");
    const firstSessionId = harness.runtime.sessionRuntime.session.sessionId;
    const firstUserEntry = harness.runtime.sessionRuntime.session.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user");
    expect(firstUserEntry).toBeDefined();

    await harness.runtime.sessionRuntime.newSession();
    harness.mock.enqueue(classifier(), { type: "text", text: "new" });
    await harness.runtime.sessionRuntime.session.prompt("New task.");
    expect(harness.runtime.sessionRuntime.session.sessionId).not.toBe(firstSessionId);

    const newUserEntry = harness.runtime.sessionRuntime.session.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user");
    expect(newUserEntry).toBeDefined();
    await harness.runtime.sessionRuntime.fork(newUserEntry!.id, { position: "at" });
    harness.mock.enqueue(classifier(), { type: "text", text: "fork" });
    await harness.runtime.sessionRuntime.session.prompt("Forked task.");

    expect(harness.mock.state.inferenceModels.filter((model) => model === "classifier")).toHaveLength(3);
    expect(firstUserEntry!.id).toBeTruthy();
  });

  it.each(["weak-only", "strong-only"] as const)(
    "uses the fixed %s Pi model with zero classifier calls",
    async (mode) => {
      const harness = await createHarness({ mode });
      harness.mock.enqueue({ type: "text", text: "fixed" });
      await harness.runtime.sessionRuntime.session.prompt("Fixed baseline.");
      expect(harness.mock.state.inferenceModels).toEqual([mode === "weak-only" ? "weak" : "strong"]);
      expect(await harness.runtime.routing!.store.read(harness.runtime.sessionRuntime.session.sessionId))
        .toMatchObject({
          source: "fixed-baseline",
          selectedTier: mode === "weak-only" ? "weak" : "strong",
          classifier: null,
        });
    },
  );

  it("enforces coding request and assistant-turn limits without changing tiers", async () => {
    const timed = await createHarness({
      mode: "weak-only",
      inferenceDelayMs: 1_500,
      execution: { requestTimeoutSeconds: 1 },
    });
    timed.mock.enqueue({ type: "text", text: "too late" });
    await timed.runtime.sessionRuntime.session.prompt("Time out this provider request.");
    expect(timed.runtime.routing!.lastError).toMatch(/coding provider request exceeded/);
    expect(timed.mock.state.inferenceModels).not.toContain("strong");
    expect(
      await timed.runtime.routing!.store.read(timed.runtime.sessionRuntime.session.sessionId),
    ).toMatchObject({ selectedTier: "weak" });

    const turns = await createHarness({
      mode: "weak-only",
      execution: { maxAgentTurns: 1 },
    });
    turns.mock.enqueue(
      {
        type: "tool",
        name: "write",
        arguments: { path: "turn-limit.txt", content: "one turn\n" },
      },
      { type: "text", text: "second turn" },
    );
    await turns.runtime.sessionRuntime.session.prompt("Exceed one assistant turn.");
    expect(turns.runtime.routing!.lastError).toMatch(/maxAgentTurns=1/);
    expect(turns.mock.state.inferenceModels).toEqual(["weak"]);
    expect(turns.mock.state.inferenceModels).not.toContain("strong");
  });

  it("does not persist or request strong when routing is cancelled or the classifier fails", async () => {
    const cancelled = await createHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled.runtime.routing!.create(
        "cancelled task",
        cancelled.runtime.sessionRuntime.session.sessionId,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(cancelled.mock.state.inferenceModels).toEqual([]);
    expect(
      await cancelled.runtime.routing!.store.read(cancelled.runtime.sessionRuntime.session.sessionId),
    ).toBeNull();

    const failed = await createHarness();
    failed.mock.enqueue({ type: "error", status: 429, message: "quota exhausted" });
    await failed.runtime.sessionRuntime.session.prompt("Quota task.");
    expect(failed.runtime.routing!.lastError).toMatch(/bridge_model_error|quota/i);
    expect(failed.mock.state.inferenceModels).toEqual(["classifier"]);
    expect(failed.mock.state.inferenceModels).not.toContain("strong");
    expect(
      await failed.runtime.routing!.store.read(failed.runtime.sessionRuntime.session.sessionId),
    ).toBeNull();

    const crashed = await createHarness();
    await crashed.bridge.dispose();
    await crashed.runtime.sessionRuntime.session.prompt("Bridge crash before persistence.");
    expect(crashed.runtime.routing!.lastError).toMatch(/Bridge exited|Bridge input/);
    expect(
      await crashed.runtime.routing!.store.read(crashed.runtime.sessionRuntime.session.sessionId),
    ).toBeNull();
    expect(crashed.mock.state.inferenceModels).toEqual([]);
  });

  it("blocks resume when configuration changes or durable decision state is corrupt", async () => {
    const harness = await createHarness();
    harness.mock.enqueue(classifier(), { type: "text", text: "persist" });
    await harness.runtime.sessionRuntime.session.prompt("Persist this session.");
    const sessionId = harness.runtime.sessionRuntime.session.sessionId;
    await harness.runtime.sessionRuntime.dispose();
    await harness.bridge.dispose();

    const changed = await createHarness({
      root: harness.root,
      mock: harness.mock,
      resume: sessionId,
      threshold: 0.8,
    });
    expect(changed.runtime.routing!.lastError).toMatch(
      /does not match the selected auth profile or model\/provider configuration/,
    );
    await changed.runtime.sessionRuntime.dispose();
    await changed.bridge.dispose();

    const changedProfile = await createHarness({
      root: harness.root,
      mock: harness.mock,
      resume: sessionId,
      authProfile: "mock-alternate",
    });
    expect(changedProfile.runtime.routing!.lastError).toMatch(
      /does not match the selected auth profile or model\/provider configuration/,
    );
    await changedProfile.runtime.sessionRuntime.dispose();
    await changedProfile.bridge.dispose();

    const decisionPath = harness.runtime.routing!.store.pathFor(sessionId);
    await writeFile(decisionPath, "{corrupt\n", { mode: 0o600 });
    const corrupt = await createHarness({
      root: harness.root,
      mock: harness.mock,
      resume: sessionId,
    });
    expect(corrupt.runtime.routing!.lastError).toMatch(/Routing decision is corrupt/);
  });

  it("rejects a corrupt Pi custom entry and changed provider configuration on resume", async () => {
    const customHarness = await createHarness();
    customHarness.mock.enqueue(classifier(), { type: "text", text: "persist" });
    await customHarness.runtime.sessionRuntime.session.prompt("Persist custom state.");
    const customSessionId = customHarness.runtime.sessionRuntime.session.sessionId;
    const sessionFile = customHarness.runtime.sessionRuntime.session.sessionFile;
    expect(sessionFile).toBeDefined();
    await customHarness.runtime.sessionRuntime.dispose();
    await customHarness.bridge.dispose();
    const rewritten = (await readFile(sessionFile!, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => {
        const entry = JSON.parse(line) as { type: string; customType?: string; data?: unknown };
        if (entry.type === "custom" && entry.customType === ROUTING_DECISION_ENTRY) {
          entry.data = { corrupt: true };
        }
        return JSON.stringify(entry);
      })
      .join("\n");
    await writeFile(sessionFile!, `${rewritten}\n`);
    const corruptCustom = await createHarness({
      root: customHarness.root,
      mock: customHarness.mock,
      resume: customSessionId,
    });
    expect(corruptCustom.runtime.routing!.lastError).toMatch(/Invalid routing decision in Pi custom entry/);

    const providerHarness = await createHarness();
    providerHarness.mock.enqueue(classifier(), { type: "text", text: "persist" });
    await providerHarness.runtime.sessionRuntime.session.prompt("Persist provider state.");
    const providerSessionId = providerHarness.runtime.sessionRuntime.session.sessionId;
    await providerHarness.runtime.sessionRuntime.dispose();
    await providerHarness.bridge.dispose();
    const replacementProvider = await startMockPiServer();
    cleanup.push(() => replacementProvider.close());
    const changedProvider = await createHarness({
      root: providerHarness.root,
      mock: replacementProvider,
      resume: providerSessionId,
    });
    expect(changedProvider.runtime.routing!.lastError).toMatch(
      /does not match the selected auth profile or model\/provider configuration/,
    );
  });

  it("retains a persisted weak decision across bridge failure and rejects cross-process logout", async () => {
    const harness = await createHarness();
    harness.mock.enqueue(classifier(), { type: "text", text: "selected" });
    await harness.runtime.sessionRuntime.session.prompt("Select weak.");
    await harness.bridge.dispose();

    harness.mock.enqueue({ type: "text", text: "after bridge exit" });
    await harness.runtime.sessionRuntime.session.prompt("Continue without the bridge.");
    expect(harness.mock.state.inferenceModels).toEqual(["classifier", "weak", "weak"]);

    const other = await ModelRuntime.create({
      authPath: join(harness.root, "profile", "auth.json"),
      modelsPath: join(harness.root, "profile", "models.json"),
      allowModelNetwork: false,
    });
    registerMockPiProvider(other, "mock", harness.mock.baseUrl);
    await other.logout("mock");
    await harness.runtime.sessionRuntime.session.prompt("Do not rescue this.");
    expect(harness.runtime.routing!.lastError).toMatch(/authentication is required/);
    expect(harness.mock.state.inferenceModels).not.toContain("strong");
  });

  it("keeps revoked credentials and selected-model failures on the chosen tier", async () => {
    const revoked = await createHarness();
    revoked.mock.enqueue(classifier(), { type: "text", text: "selected" });
    await revoked.runtime.sessionRuntime.session.prompt("Select weak.");
    revoked.mock.revoke();
    await revoked.runtime.sessionRuntime.session.prompt("Provider must reject this.");
    expect(revoked.runtime.sessionRuntime.session.model).toMatchObject({ provider: "mock", id: "weak" });
    expect(revoked.mock.state.inferenceModels).not.toContain("strong");

    const failed = await createHarness();
    failed.mock.enqueue(
      classifier(),
      { type: "error", status: 500, message: "selected weak model failed" },
    );
    await failed.runtime.sessionRuntime.session.prompt("Do not escalate.");
    expect(failed.mock.state.inferenceModels).toEqual(["classifier", "weak"]);
    expect(failed.mock.state.inferenceModels).not.toContain("strong");
  });
});
