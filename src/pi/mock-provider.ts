import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ScriptedResponse =
  | {
      type: "text";
      text: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      responseModel?: string;
      servedModel?: string;
      streamFailure?: string;
    }
  | {
      type: "tool";
      name: string;
      arguments: Record<string, unknown>;
      fragments?: string[];
      responseModel?: string;
    }
  | { type: "error"; status: number; message: string };

function usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning?: number,
) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function baseMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(0, 0),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamScript(
  model: Model<Api>,
  script: Exclude<ScriptedResponse, { type: "error" }>,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial = baseMessage(model);
    if (script.type === "text" && script.servedModel) partial.model = script.servedModel;
    if (script.responseModel) partial.responseModel = script.responseModel;
    stream.push({ type: "start", partial: structuredClone(partial) });
    if (script.type === "text") {
      partial.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex: 0, partial: structuredClone(partial) });
      for (const delta of [script.text.slice(0, 3), script.text.slice(3)].filter(Boolean)) {
        const block = partial.content[0];
        if (block?.type === "text") block.text += delta;
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial: structuredClone(partial) });
      }
      if (script.streamFailure) {
        partial.stopReason = "error";
        partial.errorMessage = script.streamFailure;
        stream.push({ type: "error", reason: "error", error: partial });
        stream.end(partial);
        return;
      }
      stream.push({ type: "text_end", contentIndex: 0, content: script.text, partial: structuredClone(partial) });
      partial.usage = usage(
        script.inputTokens ?? 11,
        script.outputTokens ?? 7,
        script.cacheReadTokens ?? 0,
        script.cacheWriteTokens ?? 0,
        script.reasoningTokens,
      );
      stream.push({ type: "done", reason: "stop", message: partial });
      stream.end(partial);
      return;
    }
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "mock-tool-call",
      name: script.name,
      arguments: {},
    };
    partial.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: structuredClone(partial) });
    const encoded = JSON.stringify(script.arguments);
    for (const delta of script.fragments ?? [encoded]) {
      stream.push({ type: "toolcall_delta", contentIndex: 0, delta, partial: structuredClone(partial) });
    }
    toolCall.arguments = script.arguments;
    partial.stopReason = "toolUse";
    partial.usage = usage(13, 9);
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: structuredClone(partial) });
    stream.push({ type: "done", reason: "toolUse", message: partial });
    stream.end(partial);
  });
  return stream;
}

export function registerMockPiProvider(
  runtime: ModelRuntime,
  id: string,
  baseUrl: string,
  modelIds: readonly string[] = ["classifier", "weak", "strong"],
  onAuthEvent?: (event: {
    action: "login" | "refresh";
    outcome: "success" | "error";
  }) => void,
): void {
  const models = modelIds.map((modelId) => ({
    id: modelId,
    name: `Mock ${modelId}`,
    api: "mock-phase01",
    provider: id,
    baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4096,
  }));
  const streamSimple = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        const result = await fetch(`${baseUrl}/infer`, {
          method: "POST",
          headers: {
            "x-api-key": options?.apiKey ?? "",
            "content-type": "application/json",
            "x-model-id": model.id,
          },
          body: JSON.stringify({
            ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
            messages: context.messages,
            tools: context.tools ?? [],
          }),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        const body = (await result.json()) as Exclude<ScriptedResponse, { type: "error" }> | { error: string };
        if (!result.ok || "error" in body) {
          throw new Error(`HTTP ${result.status}: ${"error" in body ? body.error : "provider error"}`);
        }
        for await (const event of streamScript(model, body)) output.push(event);
      } catch (error) {
        const message: AssistantMessage = {
          ...baseMessage(model),
          stopReason: options?.signal?.aborted ? "aborted" : "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        output.push({ type: "error", reason: message.stopReason as "aborted" | "error", error: message });
        output.end(message);
      }
    });
    return output;
  };
  runtime.registerProvider(id, {
    name: `Routing lab mock ${id}`,
    baseUrl,
    api: "mock-phase01",
    oauth: {
      name: "Routing lab mock OAuth",
      isSubscription: true,
      login: async () => {
        try {
          const response = await fetch(`${baseUrl}/oauth/login`, { method: "POST" });
          const credential = (await response.json()) as {
            access: string;
            refresh: string;
            expires: number;
          };
          onAuthEvent?.({ action: "login", outcome: "success" });
          return credential;
        } catch (error) {
          onAuthEvent?.({ action: "login", outcome: "error" });
          throw error;
        }
      },
      refreshToken: async (credential, signal) => {
        try {
          const response = await fetch(`${baseUrl}/oauth/refresh`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refresh: credential.refresh }),
            signal,
          });
          if (!response.ok) throw new Error(`OAuth refresh failed: HTTP ${response.status}`);
          const refreshed = (await response.json()) as {
            access: string;
            refresh: string;
            expires: number;
          };
          onAuthEvent?.({ action: "refresh", outcome: "success" });
          return refreshed;
        } catch (error) {
          onAuthEvent?.({ action: "refresh", outcome: "error" });
          throw error;
        }
      },
      getApiKey: (credential) => credential.access,
    },
    models,
    streamSimple,
  });
}
