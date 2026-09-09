import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import type { BridgeCallModelFrame, BridgeDecision, ClassifierResult } from "../bridge/protocol.js";
import type { SwitchyardBridgeClient } from "../bridge/client.js";
import type { LibraryPolicy, PiRoleConfig } from "../config/lab-config.js";
import { registerMockPiProvider } from "./mock-provider.js";
import { ExecutionLimitError } from "./execution-failure.js";

export type { PiModelIdentity, PiRoleConfig } from "../config/lab-config.js";

export interface ResolvedPiRoles {
  classifier: Model<Api>;
  weak: Model<Api>;
  strong: Model<Api>;
}

export interface ProfileModelRuntimeOptions {
  authPath: string;
  modelsPath: string | null;
  allowModelNetwork?: boolean;
  modelRefreshTimeoutMs?: number;
  mockProvider?: {
    id?: string;
    baseUrl: string;
    modelIds?: readonly string[];
  };
}

export async function profileModelRuntime(options: ProfileModelRuntimeOptions): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: options.authPath,
    modelsPath: options.modelsPath,
    allowModelNetwork: options.allowModelNetwork ?? false,
    refreshOnCreate: false,
    ...(options.modelRefreshTimeoutMs === undefined
      ? {}
      : { modelRefreshTimeoutMs: options.modelRefreshTimeoutMs }),
  });
  if (options.mockProvider) {
    registerMockPiProvider(
      runtime,
      options.mockProvider.id ?? "mock",
      options.mockProvider.baseUrl,
      options.mockProvider.modelIds,
    );
  }
  return runtime;
}

export function resolvePiRoles(runtime: ModelRuntime, config: PiRoleConfig): ResolvedPiRoles {
  const resolve = (role: keyof PiRoleConfig): Model<Api> => {
    const identity = config[role];
    const model = runtime.getModel(identity.provider, identity.model);
    if (!model) {
      throw new Error(`Unknown Pi ${role} model: ${identity.provider}/${identity.model}`);
    }
    return model;
  };
  return {
    classifier: resolve("classifier"),
    weak: resolve("weak"),
    strong: resolve("strong"),
  };
}

function messageText(message: BridgeCallModelFrame["request"]["messages"][number]): string {
  return message.content
    .filter((block): block is { type: string; text: string } => typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function classifierSystemPrompt(request: BridgeCallModelFrame): string | undefined {
  const instructions = (request.request.instructions ?? []).map(messageText).filter(Boolean);
  const responseFormat = request.request.output?.response_format;
  if (responseFormat !== undefined && responseFormat !== null) {
    instructions.push(
      `Return exactly one JSON object matching this Switchyard-supplied response format:\n${JSON.stringify(responseFormat)}`,
    );
  }
  return instructions.length === 0 ? undefined : instructions.join("\n\n");
}

function classifierFailure(
  message: string,
  aborted = false,
): NonNullable<Extract<ClassifierResult, { error: unknown }>["error"]> {
  const normalized = message.toLowerCase();
  const kind =
    aborted || normalized.includes("abort")
      ? "cancelled"
      : normalized.includes("not configured") ||
          normalized.includes("auth") ||
          normalized.includes("oauth") ||
          normalized.includes("credential")
        ? "auth"
        : normalized.includes("quota")
          ? "quota"
          : normalized.includes("rate limit") || normalized.includes("http 429")
            ? "rate_limit"
            : normalized.includes("transport") ||
                normalized.includes("network") ||
                normalized.includes("fetch")
              ? "transport"
              : "provider";
  return {
    kind,
    message: {
      auth: "Pi classifier authentication is unavailable",
      cancelled: "Pi classifier request was cancelled",
      provider: "Pi classifier provider request failed",
      quota: "Pi classifier quota is unavailable",
      rate_limit: "Pi classifier request was rate limited",
      transport: "Pi classifier transport failed",
    }[kind],
  };
}

export async function callClassifierThroughPi(
  runtime: ModelRuntime,
  model: Model<Api>,
  request: BridgeCallModelFrame,
  options: { requestTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ClassifierResult> {
  const messages: Message[] = [];
  for (const message of request.request.messages) {
    const text = messageText(message);
    if (!text) continue;
    if (message.role === "assistant") {
      messages.push({
            role: "assistant" as const,
            content: [{ type: "text" as const, text }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: Date.now(),
      });
    } else {
      messages.push({ role: "user", content: text, timestamp: Date.now() });
    }
  }
  const systemPrompt = classifierSystemPrompt(request);
  const context: Context = {
    messages,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
  const maxTokens = request.request.output?.max_output_tokens;
  // A provider-independent conservative envelope. No silent truncation or token-count precision claim.
  const inputBound = Buffer.byteLength(JSON.stringify(context), "utf8") + 256;
  if (inputBound + (maxTokens ?? model.maxTokens) > model.contextWindow) {
    return { error: { kind: "provider", message: "unsupported-input: classifier prompt exceeds the conservative context envelope (UTF-8 bytes plus framing and output reserve)" } };
  }
  const timeoutSignal =
    options.requestTimeoutMs === undefined ? undefined : AbortSignal.timeout(options.requestTimeoutMs);
  const signals = [options.signal, timeoutSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal =
    signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try {
    const result = await runtime.completeSimple(model, context, {
      ...(maxTokens === undefined || maxTokens === null ? {} : { maxTokens }),
      ...(signal === undefined ? {} : { signal }),
      maxRetries: 0,
    });
    if (timeoutSignal?.aborted && !options.signal?.aborted) {
      throw new ExecutionLimitError("timeout", "Classifier provider request timeout exceeded");
    }
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      return {
        error: classifierFailure(
          result.errorMessage ?? "Pi classifier call failed",
          result.stopReason === "aborted",
        ),
      };
    }
    return {
      text: result.content
        .filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join(""),
      usage: {
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        cacheReadTokens: result.usage.cacheRead,
        cacheWriteTokens: result.usage.cacheWrite,
        ...(result.usage.reasoning === undefined ? {} : { reasoningTokens: result.usage.reasoning }),
        totalTokens: result.usage.totalTokens,
      },
      provider: result.provider,
      model: result.model,
      ...(result.responseModel === undefined
        ? {}
        : { providerReportedModelId: result.responseModel }),
    };
  } catch (error) {
    if (timeoutSignal?.aborted && !options.signal?.aborted) {
      throw new ExecutionLimitError("timeout", "Classifier provider request timeout exceeded");
    }
    return {
      error: classifierFailure(error instanceof Error ? error.message : "Pi classifier provider request failed"),
    };
  }
}

export async function resolveDecision(
  bridge: SwitchyardBridgeClient,
  runtime: ModelRuntime,
  roles: ResolvedPiRoles,
  task: string,
  decisionId: string,
  policy: LibraryPolicy = {
    weakThreshold: 0.75,
    weakCapabilityDescription: "Use Switchyard's packaged efficient-agent capability card.",
    maxOutputTokens: Math.min(4096, roles.classifier.maxTokens),
  },
  requestTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<BridgeDecision> {
  return bridge.resolveDecision({
    decisionId,
    task,
    weakThreshold: policy.weakThreshold,
    weakCapabilityDescription: policy.weakCapabilityDescription,
    maxOutputTokens: Math.min(policy.maxOutputTokens, roles.classifier.maxTokens),
    ...(signal === undefined ? {} : { signal }),
    callClassifier: (request) =>
      callClassifierThroughPi(runtime, roles.classifier, request, {
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        ...(signal === undefined ? {} : { signal }),
      }),
  });
}

export async function selectNativePiModel(
  session: AgentSession,
  roles: ResolvedPiRoles,
  decision: BridgeDecision,
): Promise<Model<Api>> {
  const selected = decision.selectedAlias === "weak" ? roles.weak : roles.strong;
  await session.setModel(selected);
  return selected;
}

export async function runRoutedPiSession(options: {
  bridge: SwitchyardBridgeClient;
  runtime: ModelRuntime;
  roles: ResolvedPiRoles;
  session: AgentSession;
  task: string;
  decisionId: string;
}): Promise<BridgeDecision> {
  const decision = await resolveDecision(
    options.bridge,
    options.runtime,
    options.roles,
    options.task,
    options.decisionId,
  );
  await selectNativePiModel(options.session, options.roles, decision);
  await options.session.prompt(options.task);
  return decision;
}
