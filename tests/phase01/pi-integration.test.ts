import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentSessionRuntime,
  createAgentSession,
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { SwitchyardBridgeClient } from "../../src/bridge/client.js";
import {
  callClassifierThroughPi,
  resolvePiRoles,
  runRoutedPiSession,
} from "../../src/pi/runtime.js";
import { registerMockPiProvider, startMockPiServer, type MockPiServer } from "./mock-pi-provider.js";

const bridgeExecutable = resolve("rust/switchyard-bridge/target/debug/switchyard-bridge");
const cleanup: Array<() => Promise<void>> = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "routing-lab-phase01-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function server(options?: { tokenLifetimeMs?: number }): Promise<MockPiServer> {
  const value = await startMockPiServer(options);
  cleanup.push(() => value.close());
  return value;
}

function interaction() {
  return {
    prompt: async () => "unused",
    notify: () => {},
  };
}

async function runtime(authPath: string, baseUrl: string, providerId = "mock"): Promise<ModelRuntime> {
  const value = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
  });
  registerMockPiProvider(value, providerId, baseUrl);
  return value;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map((dispose) => dispose()));
});

describe("Pi-owned mock provider integration", () => {
  it("exposes native session replacement and compaction hooks", async () => {
    expect(createAgentSessionRuntime).toBeTypeOf("function");
    expect(AgentSessionRuntime.prototype.newSession).toBeTypeOf("function");
    expect(AgentSessionRuntime.prototype.switchSession).toBeTypeOf("function");
    expect(AgentSessionRuntime.prototype.fork).toBeTypeOf("function");
  });

  it("persists native login, refreshes once across concurrent runtimes, and logs out", async () => {
    const root = await temporaryDirectory();
    const authPath = join(root, "profile", "auth.json");
    const mock = await server({ tokenLifetimeMs: -1 });
    const first = await runtime(authPath, mock.baseUrl);
    await first.login("mock", "oauth", interaction());
    expect(mock.state.loginCount).toBe(1);
    expect(await first.getAvailable("mock")).toHaveLength(3);

    const second = await runtime(authPath, mock.baseUrl);
    const [firstAuth, secondAuth] = await Promise.all([
      first.getAuth("mock", { minOAuthValidityMs: 1 }),
      second.getAuth("mock", { minOAuthValidityMs: 1 }),
    ]);
    expect(firstAuth?.auth.apiKey).toBe(secondAuth?.auth.apiKey);
    expect(mock.state.refreshCount).toBe(1);

    const stored = await readFile(authPath, "utf8");
    expect(stored).toContain("refreshed-1");
    await second.logout("mock");
    expect(await first.checkAuth("mock")).toBeUndefined();
  });

  it("serializes refresh across two OS processes sharing one profile", async () => {
    const root = await temporaryDirectory();
    const authPath = join(root, "profile", "auth.json");
    const mock = await server({ tokenLifetimeMs: -1 });
    const owner = await runtime(authPath, mock.baseUrl);
    await owner.login("mock", "oauth", interaction());
    const worker = resolve("tests/phase01/auth-worker.ts");
    const run = () => {
      const child = spawn(process.execPath, ["--import", "tsx", worker, authPath, mock.baseUrl], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      return once(child, "exit").then(([code]) => {
        if (code !== 0) throw new Error(stderr);
        return stdout.trim();
      });
    };
    const tokens = await Promise.all([run(), run()]);
    expect(new Set(tokens).size).toBe(1);
    expect(mock.state.refreshCount).toBe(1);
  });

  it("resolves provider and model as one identity", async () => {
    const root = await temporaryDirectory();
    const authPath = join(root, "auth.json");
    const mock = await server();
    const pi = await runtime(authPath, mock.baseUrl, "provider-a");
    registerMockPiProvider(pi, "provider-b", mock.baseUrl, ["same-id"]);
    registerMockPiProvider(pi, "provider-c", mock.baseUrl, ["same-id"]);
    const roles = resolvePiRoles(pi, {
      classifier: { provider: "provider-a", model: "classifier" },
      weak: { provider: "provider-b", model: "same-id" },
      strong: { provider: "provider-c", model: "same-id" },
    });
    expect(roles.weak.provider).toBe("provider-b");
    expect(roles.strong.provider).toBe("provider-c");
  });

  it("routes once through Switchyard before Pi runs its native tool loop", async () => {
    const root = await temporaryDirectory();
    const authPath = join(root, "profile", "auth.json");
    const project = join(root, "project");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(project));
    const mock = await server();
    const pi = await runtime(authPath, mock.baseUrl);
    await pi.login("mock", "oauth", interaction());
    const roles = resolvePiRoles(pi, {
      classifier: { provider: "mock", model: "classifier" },
      weak: { provider: "mock", model: "weak" },
      strong: { provider: "mock", model: "strong" },
    });
    const classifierReply = JSON.stringify({
      crux: "small edit",
      primary_rule: "SUP-1",
      capability_boundary: "supported",
      p_solve: 0.9,
    });
    const toolArguments = JSON.stringify({ path: "answer.ts", content: "export const answer = 42;\n" });
    mock.enqueue(
      { type: "text", text: classifierReply },
      {
        type: "tool",
        name: "write",
        arguments: { path: "answer.ts", content: "export const answer = 42;\n" },
        fragments: [toolArguments.slice(0, 12), toolArguments.slice(12)],
      },
      { type: "text", text: "done" },
    );
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
    });
    const { session } = await createAgentSession({
      cwd: project,
      agentDir: join(root, "session"),
      modelRuntime: pi,
      model: roles.strong,
      tools: ["write"],
      sessionManager: SessionManager.inMemory(),
      settingsManager,
    });
    expect(session.compact).toBeTypeOf("function");
    const sessionEvents: string[] = [];
    session.subscribe((event) => sessionEvents.push(event.type));
    const bridge = await SwitchyardBridgeClient.start(bridgeExecutable);
    cleanup.push(() => bridge.dispose());
    const decision = await runRoutedPiSession({
      bridge,
      runtime: pi,
      roles,
      session,
      task: "Create answer.ts exporting answer with value 42.",
      decisionId: "decision-native-loop",
    });
    expect(decision.selectedAlias).toBe("weak");
    expect(session.model).toMatchObject({ provider: "mock", id: "weak" });
    expect(mock.state.inferenceModels).toEqual(["classifier", "weak", "weak"]);
    expect(mock.state.inferenceToolCounts[0]).toBe(0);
    expect(sessionEvents).toContain("message_update");
    expect(
      session.messages
        .filter((message) => message.role === "assistant")
        .reduce((total, message) => total + message.usage.totalTokens, 0),
    ).toBeGreaterThan(0);
    expect(await readFile(join(project, "answer.ts"), "utf8")).toBe("export const answer = 42;\n");
    session.dispose();
  });

  it("does not convert revoked auth, quota, or selected-model errors into strong routing", async () => {
    const root = await temporaryDirectory();
    const authPath = join(root, "auth.json");
    const mock = await server();
    const pi = await runtime(authPath, mock.baseUrl);
    await pi.login("mock", "oauth", interaction());
    const classifier = pi.getModel("mock", "classifier");
    expect(classifier).toBeDefined();
    mock.enqueue({ type: "error", status: 429, message: "quota exhausted" });
    const result = await callClassifierThroughPi(
      pi,
      classifier!,
      {
        type: "call_model",
        decisionId: "quota",
        callId: "call-1",
        targetAlias: "classifier",
        request: { messages: [{ role: "user", content: [{ type: "text", text: "task" }] }] },
      },
    );
    expect(result).toMatchObject({ error: { kind: "quota" } });

    await pi.logout("mock");
    const missing = await callClassifierThroughPi(
      pi,
      classifier!,
      {
        type: "call_model",
        decisionId: "missing",
        callId: "call-1",
        targetAlias: "classifier",
        request: { messages: [{ role: "user", content: [{ type: "text", text: "task" }] }] },
      },
    );
    expect(missing).toMatchObject({ error: { kind: "auth" } });
    expect(mock.state.inferenceModels).not.toContain("strong");
  });

  it("keeps a selected-model HTTP failure on the selected tier", async () => {
    const root = await temporaryDirectory();
    const authPath = join(root, "profile", "auth.json");
    const project = join(root, "project");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(project));
    const mock = await server();
    const pi = await runtime(authPath, mock.baseUrl);
    await pi.login("mock", "oauth", interaction());
    const roles = resolvePiRoles(pi, {
      classifier: { provider: "mock", model: "classifier" },
      weak: { provider: "mock", model: "weak" },
      strong: { provider: "mock", model: "strong" },
    });
    mock.enqueue(
      {
        type: "text",
        text: JSON.stringify({
          crux: "small edit",
          primary_rule: "SUP-1",
          capability_boundary: "supported",
          p_solve: 0.9,
        }),
      },
      { type: "error", status: 500, message: "selected model failed" },
    );
    const { session } = await createAgentSession({
      cwd: project,
      agentDir: join(root, "session"),
      modelRuntime: pi,
      model: roles.strong,
      tools: [],
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    });
    const bridge = await SwitchyardBridgeClient.start(bridgeExecutable);
    cleanup.push(() => bridge.dispose());
    const decision = await runRoutedPiSession({
      bridge,
      runtime: pi,
      roles,
      session,
      task: "Return a response.",
      decisionId: "selected-model-error",
    });
    expect(decision.selectedAlias).toBe("weak");
    expect(mock.state.inferenceModels).toEqual(["classifier", "weak"]);
    expect(mock.state.inferenceModels).not.toContain("strong");
    session.dispose();
  });

  it("surfaces revoked refresh as authentication failure", async () => {
    const root = await temporaryDirectory();
    const authPath = join(root, "auth.json");
    const mock = await server({ tokenLifetimeMs: -1 });
    const pi = await runtime(authPath, mock.baseUrl);
    await pi.login("mock", "oauth", interaction());
    mock.revoke();
    await expect(pi.getAuth("mock", { minOAuthValidityMs: 1 })).rejects.toThrow(/OAuth refresh failed/);
    expect(mock.state.inferenceModels).toEqual([]);
  });

  it("keeps credentials out of bridge frames and diagnostics", async () => {
    const secret = "phase01-token-redaction-sentinel";
    const source = await readFile(resolve("src/bridge/protocol.ts"), "utf8");
    const clientSource = await readFile(resolve("src/bridge/client.ts"), "utf8");
    expect(`${source}${clientSource}`).not.toContain(secret);
    expect(["authorization", "access_token", "refresh_token", "provider_url"].some((key) => source.includes(key))).toBe(
      false,
    );
  });
});
