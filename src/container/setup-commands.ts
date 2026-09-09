import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { Type, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SwitchyardBridgeClient } from "../bridge/client.js";
import {
  MODEL_ROLES,
  configFingerprint,
  createLibraryPolicy,
  loadConfig,
  resolveCommonModelEnvelope,
  validateCodingCompatibility,
  type LabConfig,
  type ModelRole,
} from "../config/lab-config.js";
import {
  callClassifierThroughPi,
  profileModelRuntime,
  resolveDecision,
  resolvePiRoles,
  type ResolvedPiRoles,
} from "../pi/runtime.js";
import { assertContainerStateWritable, resolveContainerPaths } from "./paths.js";

interface SetupContext {
  config: LabConfig;
  runtime: ModelRuntime;
  roles: ResolvedPiRoles;
  paths: ReturnType<typeof resolveContainerPaths>;
  authProfile: string;
  mockEnabled: boolean;
}

interface ModelCatalogEntry {
  provider: string;
  model: string;
  displayName: string;
  storedAuthAvailable: boolean;
  authType: "api_key" | "oauth" | null;
  subscription: boolean;
  capabilities: {
    contextWindow: number;
    maxOutputTokens: number;
    reasoning: boolean;
    input: ("text" | "image")[];
  };
}

function mockProvider(environment: NodeJS.ProcessEnv) {
  const baseUrl = environment.LAB_MOCK_BASE_URL;
  return baseUrl ? { id: "mock", baseUrl } : undefined;
}

async function runtimeForProfile(
  environment: NodeJS.ProcessEnv,
  allowModelNetwork = false,
): Promise<{ runtime: ModelRuntime; paths: ReturnType<typeof resolveContainerPaths> }> {
  const paths = resolveContainerPaths(environment);
  const configuredMockProvider = mockProvider(environment);
  const runtime = await profileModelRuntime({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    allowModelNetwork,
    modelRefreshTimeoutMs: 30_000,
    ...(configuredMockProvider ? { mockProvider: configuredMockProvider } : {}),
  });
  return { runtime, paths };
}

async function setupContext(configPath: string, environment: NodeJS.ProcessEnv): Promise<SetupContext> {
  const config = await loadConfig(configPath);
  const authProfile = environment.LAB_AUTH_PROFILE ?? config.authProfile;
  const { runtime, paths } = await runtimeForProfile({ ...environment, LAB_AUTH_PROFILE: authProfile });
  const roles = resolvePiRoles(runtime, config.models);
  validateCodingCompatibility(config, roles);
  return { config, runtime, roles, paths, authProfile, mockEnabled: mockProvider(environment) !== undefined };
}

async function authByProvider(runtime: ModelRuntime, models: readonly Model<Api>[]) {
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  return new Map(
    await Promise.all(
      providers.map(async (provider) => {
        const auth = await runtime.checkAuth(provider);
        return [provider, auth] as const;
      }),
    ),
  );
}

function roleSummary(
  config: LabConfig,
  roles: ResolvedPiRoles,
  auth: Awaited<ReturnType<typeof authByProvider>>,
) {
  return Object.fromEntries(
    MODEL_ROLES.map((role) => {
      const model = roles[role];
      const billing = config.models[role];
      return [
        role,
        {
          provider: model.provider,
          model: model.id,
          displayName: model.name,
          storedAuthAvailable: auth.has(model.provider) && auth.get(model.provider) !== undefined,
          billing: billing.billing ?? "unknown",
          estimatedCostUsd: null,
          referenceCostUsd:
            model.cost.input === 0 && model.cost.output === 0
              ? null
              : {
                  inputPerMillion: model.cost.input,
                  outputPerMillion: model.cost.output,
                },
        },
      ];
    }),
  );
}

export async function configProfile(configPath: string): Promise<string> {
  return (await loadConfig(configPath)).authProfile;
}

export async function checkConfig(
  configPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const context = await setupContext(configPath, environment);
  const models = MODEL_ROLES.map((role) => context.roles[role]);
  const auth = await authByProvider(context.runtime, models);
  const envelope = resolveCommonModelEnvelope(context.config, context.roles);
  const policy = createLibraryPolicy(context.config, context.roles);
  const fingerprint = configFingerprint(
    context.config,
    context.roles,
    context.runtime,
    context.authProfile,
  );
  return {
    status: "ok",
    networkCalls: 0,
    authProfile: context.authProfile,
    roles: roleSummary(context.config, context.roles, auth),
    envelope,
    policy: {
      weakThreshold: policy.weakThreshold,
      maxOutputTokens: policy.maxOutputTokens,
      capabilityCardHash: fingerprint.capabilityCardHash,
    },
    fingerprint,
  };
}

async function catalogFreshness(modelsPath: string): Promise<{ source: "built-in" | "cached"; checkedAt: string | null }> {
  try {
    const details = await stat(modelsPath);
    return { source: "cached", checkedAt: details.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { source: "built-in", checkedAt: null };
    }
    throw error;
  }
}

export async function listModels(
  options: { refresh: boolean },
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const { runtime, paths } = await runtimeForProfile(environment, options.refresh);
  const refreshErrors: string[] = [];
  if (options.refresh) {
    const signal = AbortSignal.timeout(30_000);
    const result = await runtime.refresh({ allowNetwork: true, force: true, signal });
    refreshErrors.push(...result.errors.keys());
    if (result.aborted) throw new Error("Pi model refresh was cancelled");
    const configuredProviders = runtime
      .getProviders()
      .map((provider) => provider.id)
      .filter((provider) => runtime.hasConfiguredAuth(provider));
    for (const provider of configuredProviders) {
      try {
        await runtime.getAvailable(provider, { signal });
      } catch {
        refreshErrors.push(provider);
      }
    }
    if (refreshErrors.length > 0) {
      throw new Error(`Pi model refresh failed for providers: ${[...new Set(refreshErrors)].sort().join(", ")}`);
    }
  }
  const models = runtime.getModels();
  const auth = await authByProvider(runtime, models);
  const entries: ModelCatalogEntry[] = models
    .map((model) => {
      const availability = auth.get(model.provider);
      return {
        provider: model.provider,
        model: model.id,
        displayName: model.name,
        storedAuthAvailable: availability !== undefined,
        authType: availability?.type ?? null,
        subscription: runtime.isUsingSubscription(model.provider),
        capabilities: {
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxTokens,
          reasoning: model.reasoning,
          input: [...model.input],
        },
      };
    })
    .sort((left, right) =>
      `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`),
    );
  return {
    authProfile: paths.authProfile,
    refreshRequested: options.refresh,
    refreshErrors,
    freshness: await catalogFreshness(paths.modelsPath),
    models: entries,
  };
}

export function renderModelCatalog(result: Awaited<ReturnType<typeof listModels>>): string {
  const models = result.models as ModelCatalogEntry[];
  const freshness = result.freshness as { source: string; checkedAt: string | null };
  const lines = [
    `Pi models for profile ${String(result.authProfile)} (${freshness.source}${
      freshness.checkedAt ? ` ${freshness.checkedAt}` : ""
    })`,
    "AUTH\tPROVIDER\tMODEL\tCONTEXT\tOUTPUT\tNAME",
  ];
  for (const model of models) {
    lines.push(
      [
        model.storedAuthAvailable ? "yes" : "no",
        model.provider,
        model.model,
        model.capabilities.contextWindow,
        model.capabilities.maxOutputTokens,
        model.displayName.replaceAll(/[\t\r\n]/g, " "),
      ].join("\t"),
    );
  }
  if ((result.refreshErrors as string[]).length > 0) {
    lines.push(`Refresh errors: ${(result.refreshErrors as string[]).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function userMessage(text: string): Context {
  return { messages: [{ role: "user", content: text, timestamp: Date.now() }] };
}

async function ensureProbeAuth(context: SetupContext): Promise<void> {
  const providers = [...new Set(MODEL_ROLES.map((role) => context.roles[role].provider))];
  for (const provider of providers) {
    if (await context.runtime.checkAuth(provider)) continue;
    if (provider !== "mock" || !context.mockEnabled) {
      throw new Error(`Pi authentication is required for provider ${provider}; run route-agent auth`);
    }
    try {
      await context.runtime.login(provider, "oauth", {
        prompt: async () => "unused",
        notify: () => {},
      });
    } catch {
      throw new Error(`Pi authentication failed for provider ${provider}; run route-agent auth`);
    }
  }
}

async function probeToolStream(
  runtime: ModelRuntime,
  model: Model<Api>,
  requestTimeoutMs: number,
): Promise<void> {
  let response;
  try {
    response = await runtime.completeSimple(
      model,
      {
        ...userMessage("Call the phase04_probe tool exactly once."),
        tools: [
          {
            name: "phase04_probe",
            description: "A no-op tool used to verify native tool-call streaming.",
            parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
          },
        ],
      },
      {
        maxTokens: Math.min(256, model.maxTokens),
        maxRetries: 0,
        signal: AbortSignal.timeout(requestTimeoutMs),
      },
    );
  } catch {
    throw new Error(`Pi model probe failed for ${model.provider}/${model.id}`);
  }
  if (response.stopReason !== "toolUse" || !response.content.some((block) => block.type === "toolCall")) {
    throw new Error(`Pi model probe did not produce a native tool call for ${model.provider}/${model.id}`);
  }
}

export async function probeModels(
  context: SetupContext,
): Promise<Record<ModelRole, { provider: string; model: string; outcome: "pass" }>> {
  await ensureProbeAuth(context);
  let available: readonly Model<Api>[];
  try {
    available = await context.runtime.getAvailable();
  } catch {
    throw new Error("Pi model availability probe failed; reauthenticate the selected profile");
  }
  for (const role of MODEL_ROLES) {
    const model = context.roles[role];
    if (!available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      throw new Error(`Configured Pi ${role} model is not available to the selected profile`);
    }
  }
  const timeoutMs = context.config.execution.requestTimeoutSeconds * 1000;
  await probeToolStream(context.runtime, context.roles.weak, timeoutMs);
  await probeToolStream(context.runtime, context.roles.strong, timeoutMs);

  const bridge = await SwitchyardBridgeClient.start(context.paths.bridgeExecutable);
  try {
    const decision = await resolveDecision(
      bridge,
      context.runtime,
      context.roles,
      "Verify the configured classifier verdict contract.",
      "phase04-doctor-probe",
      createLibraryPolicy(context.config, context.roles),
      timeoutMs,
    );
    if (decision.evidence.kind !== "validated_verdict") {
      throw new Error("Configured Pi classifier returned an incompatible verdict");
    }
  } finally {
    await bridge.dispose();
  }
  return Object.fromEntries(
    MODEL_ROLES.map((role) => [
      role,
      { provider: context.roles[role].provider, model: context.roles[role].id, outcome: "pass" },
    ]),
  ) as Record<ModelRole, { provider: string; model: string; outcome: "pass" }>;
}

export async function doctor(
  configPath: string,
  options: { probeModels: boolean },
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const context = await setupContext(configPath, environment);
  await assertContainerStateWritable(context.paths);
  await access(context.paths.bridgeExecutable, constants.X_OK);
  const bridge = await SwitchyardBridgeClient.start(context.paths.bridgeExecutable);
  await bridge.dispose();
  const staticConfig = await checkConfig(configPath, environment);
  return {
    status: "ok",
    checks: {
      node: process.versions.node,
      pi: "0.85.0",
      hostDocker: environment.LAB_HOST_DOCKER_VERSION ?? "checked-by-launcher",
      hostCompose: environment.LAB_HOST_COMPOSE_VERSION ?? "checked-by-launcher",
      bridgeProtocolVersion: 1,
      profileWritable: true,
      projectStateWritable: true,
      dependencyStateWritable: true,
      config: staticConfig,
    },
    probes: options.probeModels ? await probeModels(context) : null,
  };
}

/** Read only public probe jobs from stdin; the experiment and evaluator are never mounted here. */
export async function probeRouting(configPath: string, input: string): Promise<void> {
  const { createHash, randomUUID } = await import("node:crypto");
  const plan = JSON.parse(input);
  const { planHash, ...unsigned } = plan;
  if (plan.schemaVersion !== 1 || createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== planHash || !Array.isArray(plan.jobs) || plan.jobs.length > 630) throw new Error("Invalid public routing probe plan");
  const context = await setupContext(configPath, process.env);
  const expectedEvidence = context.mockEnabled ? "mock" : "live";
  if (plan.evidenceKind !== expectedEvidence) throw new Error("Probe evidence does not match provider setup");
  await ensureProbeAuth(context);
  const fingerprint = configFingerprint(context.config, context.roles, context.runtime, context.authProfile);
  if (fingerprint.value !== plan.fingerprint) throw new Error("Routing probe model/configuration fingerprint changed");
  const policy = createLibraryPolicy(context.config, context.roles);
  for (const job of plan.jobs) {
    if (typeof job.prompt !== "string" || typeof job.taskId !== "string" || ![0,1,2].includes(job.wording) || !Number.isInteger(job.sample) || job.sample < 0 || job.sample >= 5) throw new Error("Invalid public probe job");
    const started = performance.now();
    let bridge: SwitchyardBridgeClient | undefined;
    let usage: unknown = null;
    try {
      bridge = await SwitchyardBridgeClient.start(context.paths.bridgeExecutable);
      const decision = await bridge.resolveDecision({ decisionId: randomUUID(), task: job.prompt, ...policy,
        callClassifier: async (request) => {
          const result = await callClassifierThroughPi(context.runtime, context.roles.classifier, request, { requestTimeoutMs: context.config.execution.requestTimeoutSeconds * 1000 });
          if (!("error" in result)) usage = result.usage ?? null;
          return result;
        },
      });
      process.stdout.write(JSON.stringify({ planHash, taskId: job.taskId, wording: job.wording, sample: job.sample, status: "ok", selectedTier: decision.selectedAlias, probability: decision.evidence.kind === "validated_verdict" ? decision.evidence.weakSolveProbability : null, fallback: decision.evidence.kind === "fallback", durationMs: Math.round(performance.now()-started), usage }) + "\n");
    } catch {
      process.stdout.write(JSON.stringify({ planHash, taskId: job.taskId, wording: job.wording, sample: job.sample, status: "error", durationMs: Math.round(performance.now()-started), usage }) + "\n");
      process.exitCode = 3;
      return;
    } finally { await bridge?.dispose(); }
  }
}
