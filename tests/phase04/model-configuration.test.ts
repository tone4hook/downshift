import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configFingerprint,
  createLibraryPolicy,
  loadConfig,
  resolveCommonModelEnvelope,
  validateConfig,
  type LabConfig,
} from "../../src/config/lab-config.js";
import { checkConfig, listModels } from "../../src/container/setup-commands.js";
import { SwitchyardBridgeClient } from "../../src/bridge/client.js";
import {
  profileModelRuntime,
  resolveDecision,
  resolvePiRoles,
} from "../../src/pi/runtime.js";
import { startMockPiServer, type MockPiServer } from "../phase01/mock-pi-provider.js";

const bridgeExecutable = resolve("rust/switchyard-bridge/target/debug/switchyard-bridge");
const cleanup: Array<() => Promise<void>> = [];

function validConfig(): LabConfig {
  return validateConfig({
    schemaVersion: 1,
    authProfile: "mock",
    models: {
      classifier: { provider: "mock", model: "classifier", billing: "subscription" },
      weak: { provider: "mock", model: "weak" },
      strong: { provider: "mock", model: "strong", billing: "unknown" },
    },
    routing: {
      weakThreshold: 0.75,
      weakCapabilityDescription: "Can complete bounded TypeScript edits with executable tests.",
    },
    execution: {
      maxAgentTurns: 40,
      timeoutSeconds: 900,
      requestTimeoutSeconds: 120,
      validationTimeoutSeconds: 120,
      contextTokenCap: 32768,
      maxOutputTokens: 4096,
      thinking: "off",
    },
  });
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "routing-lab-phase04-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function server(options?: { tokenLifetimeMs?: number }): Promise<MockPiServer> {
  const value = await startMockPiServer(options);
  cleanup.push(() => value.close());
  return value;
}

async function writeConfig(root: string, config = validConfig()): Promise<string> {
  const path = join(root, "lab.json");
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

function environment(root: string, baseUrl: string): NodeJS.ProcessEnv {
  return {
    LAB_AUTH_PROFILE: "mock",
    LAB_MOCK_BASE_URL: baseUrl,
    PI_PROFILE_ROOT: join(root, "profile"),
    LAB_PROJECT_STATE: join(root, "state"),
    LAB_WORKSPACE: join(root, "workspace"),
    SWITCHYARD_BRIDGE: bridgeExecutable,
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map((dispose) => dispose()));
});

describe("LabConfig", () => {
  it("normalizes billing and rejects unknown keys with an actionable path", () => {
    const config = validConfig();
    expect(config.models.weak.billing).toBe("unknown");
    expect(() =>
      validateConfig({
        ...config,
        routing: { ...config.routing, unexpected: true },
      }),
    ).toThrow(/\/routing contains unknown field unexpected/);
  });

  it("rejects invalid thresholds, capability cards, timeout envelopes, and billing assumptions", () => {
    const config = validConfig();
    expect(() =>
      validateConfig({ ...config, routing: { ...config.routing, weakThreshold: 1.01 } }),
    ).toThrow(/weakThreshold/);
    expect(() =>
      validateConfig({ ...config, routing: { ...config.routing, weakCapabilityDescription: " \n" } }),
    ).toThrow(/weakCapabilityDescription/);
    expect(() =>
      validateConfig({
        ...config,
        execution: { ...config.execution, requestTimeoutSeconds: 901 },
      }),
    ).toThrow(/must not exceed/);
    expect(() =>
      validateConfig({
        ...config,
        models: {
          ...config.models,
          weak: { provider: "mock", model: "weak", billing: "subscription", pricing: {
            inputPerMillion: 1,
            outputPerMillion: 2,
            currency: "USD",
            asOf: "2026-09-05",
          } },
        },
      }),
    ).toThrow(/pricing/);
  });

  it("loads strict JSON and keeps the example visibly unconfigured", async () => {
    const example = await loadConfig(resolve("config/lab.example.json"));
    expect(example.models.weak.provider).toBe("CHOOSE_PI_PROVIDER");
    expect(await readFile(resolve("config/lab.example.json"), "utf8")).not.toMatch(
      /access_token|refresh_token|authorization/i,
    );
  });
});

describe("Pi role configuration", () => {
  it("rejects unsupported coding caps during static checks without inference", async () => {
    const root = await temporaryDirectory();
    const mock = await server();
    const config = validConfig();
    config.execution.maxOutputTokens = 100;
    await expect(checkConfig(await writeConfig(root, config), environment(root, mock.baseUrl)))
      .rejects.toThrow(/matching native limits/);
    expect(mock.state.inferenceModels).toEqual([]);
  });
  it("preserves provider/model identity, derives common limits, and excludes token rotation from fingerprints", async () => {
    const root = await temporaryDirectory();
    const mock = await server({ tokenLifetimeMs: -1 });
    const runtime = await profileModelRuntime({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      mockProvider: { baseUrl: mock.baseUrl },
    });
    const config = validConfig();
    const roles = resolvePiRoles(runtime, config.models);
    expect(roles.weak).toMatchObject({ provider: "mock", id: "weak" });
    expect(resolveCommonModelEnvelope(config, roles)).toEqual({
      contextTokenCap: 32768,
      maxOutputTokens: 4096,
      classifierMaxOutputTokens: 4096,
      thinking: "off",
    });
    const before = configFingerprint(config, roles, runtime);
    await runtime.login("mock", "oauth", { prompt: async () => "unused", notify: () => {} });
    await runtime.getAuth("mock", { minOAuthValidityMs: 1 });
    const after = configFingerprint(config, roles, runtime);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("refreshed-");
  });

  it("distinguishes the same model ID under different providers and rejects missing models", async () => {
    const root = await temporaryDirectory();
    const mock = await server();
    const runtime = await profileModelRuntime({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      mockProvider: { id: "provider-a", baseUrl: mock.baseUrl, modelIds: ["same"] },
    });
    const second = await profileModelRuntime({
      authPath: join(root, "other-auth.json"),
      modelsPath: null,
      mockProvider: { id: "provider-b", baseUrl: mock.baseUrl, modelIds: ["same"] },
    });
    const firstModel = runtime.getModel("provider-a", "same");
    const secondModel = second.getModel("provider-b", "same");
    expect(firstModel?.id).toBe(secondModel?.id);
    expect(firstModel?.provider).not.toBe(secondModel?.provider);
    expect(() =>
      resolvePiRoles(runtime, {
        classifier: { provider: "provider-a", model: "same" },
        weak: { provider: "provider-a", model: "missing" },
        strong: { provider: "provider-a", model: "same" },
      }),
    ).toThrow(/Unknown Pi weak model/);
  });

  it("keeps static checks offline and reports unknown subscription cost as null", async () => {
    const root = await temporaryDirectory();
    await Promise.all([
      mkdir(join(root, "profile"), { recursive: true }),
      mkdir(join(root, "state"), { recursive: true }),
      mkdir(join(root, "workspace", "node_modules"), { recursive: true }),
    ]);
    const configPath = await writeConfig(root);
    const unreachable = "http://127.0.0.1:9";
    const result = await checkConfig(configPath, environment(root, unreachable));
    expect(result.networkCalls).toBe(0);
    expect(result).toMatchObject({
      status: "ok",
      roles: {
        classifier: { billing: "subscription", estimatedCostUsd: null },
        weak: { storedAuthAvailable: false, estimatedCostUsd: null },
      },
    });
    const catalog = await listModels({ refresh: false }, environment(root, unreachable));
    expect(catalog.refreshRequested).toBe(false);
    expect((catalog.models as Array<{ provider: string }>).some((model) => model.provider === "mock")).toBe(true);
  });

  it("passes the weak capability description and Switchyard schema through a tool-free Pi classifier call", async () => {
    const root = await temporaryDirectory();
    const mock = await server();
    const runtime = await profileModelRuntime({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      mockProvider: { baseUrl: mock.baseUrl },
    });
    await runtime.login("mock", "oauth", { prompt: async () => "unused", notify: () => {} });
    const config = validConfig();
    const roles = resolvePiRoles(runtime, config.models);
    mock.enqueue({
      type: "text",
      text: JSON.stringify({
        crux: "bounded edit",
        primary_rule: "SUP-1",
        capability_boundary: "supported",
        p_solve: 0.9,
      }),
    });
    const bridge = await SwitchyardBridgeClient.start(bridgeExecutable);
    cleanup.push(() => bridge.dispose());
    const decision = await resolveDecision(
      bridge,
      runtime,
      roles,
      "Implement the bounded change.",
      "phase04-contract",
      createLibraryPolicy(config, roles),
    );
    expect(decision).toMatchObject({
      selectedAlias: "weak",
      evidence: { kind: "validated_verdict", weakSolveProbability: 0.9 },
    });
    expect(mock.state.inferenceToolCounts).toEqual([0]);
    expect(mock.state.inferenceBodies[0]).toContain(config.routing.weakCapabilityDescription);
    expect(mock.state.inferenceBodies[0]).toContain("CapabilityClassifierDecision");
  });
});
