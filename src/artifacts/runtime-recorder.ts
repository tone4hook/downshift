import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { LabConfig, ResolvedPiRoleModels } from "../config/lab-config.js";
import type {
  RoutingDecision,
  SessionMode,
  SessionRoutingEvent,
} from "../pi/session-routing.js";
import { ExecutionLimitError } from "../pi/execution-failure.js";
import {
  startAttempt,
  type AttemptArtifactStore,
  type EvidenceKind,
  type ExecutionStatus,
  type RunProvenance,
  type RunResult,
} from "./run-artifacts.js";
import {
  calculateRoleCost,
  normalizeUsage,
  UsageLedger,
  type NormalizedUsage,
} from "./usage.js";

export interface RuntimeRecorderOptions {
  stateRoot: string;
  artifactCollection?: "runs" | "attempts";
  workspace: string;
  projectId: string;
  piSessionId: string;
  runId: string;
  mode: SessionMode;
  evidenceKind: EvidenceKind;
  authProfile: string;
  config: LabConfig;
  roles: ResolvedPiRoleModels;
  fingerprint: {
    configHash: string;
    capabilityCardHash: string;
    modelMetadataHash: string;
    providerConfigHash: string;
  };
  environment: NodeJS.ProcessEnv;
  setupDurationMs: number;
  experimentId?: string | null;
  taskId?: string | null;
  repetition?: number | null;
  taskHash?: string | null;
  sourceHash?: string | null;
  validatorHash?: string | null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function metadataHash(model: Model<Api>): string {
  return hash({
    provider: model.provider,
    model: model.id,
    api: model.api,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  });
}

function referencePricing(model: Model<Api>) {
  if (
    model.cost.input === 0 &&
    model.cost.output === 0 &&
    model.cost.cacheRead === 0 &&
    model.cost.cacheWrite === 0
  ) {
    return undefined;
  }
  return {
    inputPerMillion: model.cost.input,
    outputPerMillion: model.cost.output,
    cacheReadPerMillion: model.cost.cacheRead,
    cacheWritePerMillion: model.cost.cacheWrite,
  };
}

function provenance(options: RuntimeRecorderOptions): RunProvenance {
  const labRevision = options.environment.LAB_REVISION;
  const dirty = options.environment.LAB_DIRTY;
  return {
    labRevision: labRevision && /^[0-9a-f]{40}$/.test(labRevision) ? labRevision : null,
    labDirty: dirty === "true" ? true : dirty === "false" ? false : null,
    piVersion: "0.85.0",
    switchyardRevision: "2dd67d76ad12961f92359153e03686773e3e8761",
    agentImageId: options.environment.LAB_AGENT_IMAGE_ID ?? null,
    configHash: options.fingerprint.configHash,
    capabilityCardHash: options.fingerprint.capabilityCardHash,
    modelMetadataHash: options.fingerprint.modelMetadataHash,
    providerConfigHash: options.fingerprint.providerConfigHash,
    authProfile: options.authProfile,
    mode: options.mode,
    limits: structuredClone(options.config.execution),
    models: {
      classifier: {
        provider: options.roles.classifier.provider,
        model: options.roles.classifier.id,
        metadataHash: metadataHash(options.roles.classifier),
      },
      weak: {
        provider: options.roles.weak.provider,
        model: options.roles.weak.id,
        metadataHash: metadataHash(options.roles.weak),
      },
      strong: {
        provider: options.roles.strong.provider,
        model: options.roles.strong.id,
        metadataHash: metadataHash(options.roles.strong),
      },
    },
    taskHash: options.taskHash ?? null,
    sourceHash: options.sourceHash ?? null,
    validatorHash: options.validatorHash ?? null,
    previousAttemptId:
      options.environment.LAB_PREVIOUS_ATTEMPT_ID &&
      options.environment.LAB_PREVIOUS_ATTEMPT_ID !== "-"
        ? options.environment.LAB_PREVIOUS_ATTEMPT_ID
        : null,
  };
}

function bridgeUsage(event: Extract<SessionRoutingEvent, { type: "provider_call" }>): NormalizedUsage | null {
  if (
    event.inputTokens === undefined ||
    event.inputTokens === null ||
    event.outputTokens === undefined ||
    event.outputTokens === null ||
    event.cacheReadTokens === undefined ||
    event.cacheReadTokens === null ||
    event.cacheWriteTokens === undefined ||
    event.cacheWriteTokens === null ||
    event.totalTokens === undefined ||
    event.totalTokens === null
  ) {
    return null;
  }
  return normalizeUsage({
    input: event.inputTokens,
    output: event.outputTokens,
    cacheRead: event.cacheReadTokens,
    cacheWrite: event.cacheWriteTokens,
    ...(event.reasoningTokens === undefined || event.reasoningTokens === null
      ? {}
      : { reasoning: event.reasoningTokens }),
    totalTokens: event.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
}

function errorStatus(message: string, fallback: "provider-error" | "harness-error" = "harness-error"): {
  status: ExecutionStatus;
  category: string;
} {
  if (/cancel|abort/i.test(message)) return { status: "cancelled", category: "cancelled" };
  if (/wall-time|timeout|timed out/i.test(message)) return { status: "timeout", category: "timeout" };
  if (/auth|credential|login|revoked|HTTP 401/i.test(message)) {
    return { status: "auth-required", category: "authentication" };
  }
  if (/rate.?limit|quota|HTTP 429/i.test(message)) {
    return { status: "rate-limited", category: "rate-limit" };
  }
  if (/provider|HTTP 5\d\d/i.test(message)) {
    return { status: "provider-error", category: "provider" };
  }
  return { status: fallback, category: fallback === "provider-error" ? "provider" : "harness" };
}

export class RuntimeArtifactRecorder {
  readonly store: AttemptArtifactStore;
  private readonly usage = new UsageLedger();
  private decision: RoutingDecision | null = null;
  private decisionObservation: RunResult["decisionObservation"] = null;
  private servedModel: RunResult["servedModel"] = null;
  private routingStartedAt: number | null = null;
  private routingDurationMs: number | null = null;
  private agentStartedAt: number | null = null;
  private agentDurationMs: number | null = null;
  private lastError: { status: ExecutionStatus; category: string } | null = null;
  private limitFailure: { status: ExecutionStatus; category: string } | null = null;
  private writeError: Error | null = null;
  private patchCaptured = false;
  private finalizedResult: RunResult | null = null;
  private readonly pending = new Set<Promise<void>>();

  private constructor(
    private readonly options: RuntimeRecorderOptions,
    store: AttemptArtifactStore,
  ) {
    this.store = store;
  }

  static async start(options: RuntimeRecorderOptions): Promise<RuntimeArtifactRecorder> {
    const store = await startAttempt({
      stateRoot: options.stateRoot,
      ...(options.artifactCollection ? { collection: options.artifactCollection } : {}),
      identity: {
        projectId: options.projectId,
        piSessionId: options.piSessionId,
        runId: options.runId,
        attemptId: options.runId,
        experimentId: options.experimentId ?? null,
        taskId: options.taskId ?? null,
        repetition: options.repetition ?? null,
      },
      evidenceKind: options.evidenceKind,
      mode: options.mode,
      provenance: provenance(options),
      setupDurationMs: options.setupDurationMs,
    });
    const recorder = new RuntimeArtifactRecorder(options, store);
    await store.appendEvent("startup", {
      mode: options.mode,
      evidenceKind: options.evidenceKind,
      authProfile: options.authProfile,
      configHash: options.fingerprint.configHash,
    });
    return recorder;
  }

  private track(operation: Promise<void>): void {
    this.pending.add(operation);
    void operation
      .catch((error) => {
        this.writeError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => this.pending.delete(operation));
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
    if (this.writeError) throw new Error("Run artifact write failed", { cause: this.writeError });
  }

  get isFinalized(): boolean {
    return this.finalizedResult !== null;
  }

  recordRoutingEvent(event: SessionRoutingEvent): void {
    if (event.type === "execution_start") {
      this.agentStartedAt = performance.now();
      return;
    }
    if (event.type === "provider_call") {
      if (event.action === "start") this.routingStartedAt = performance.now();
      if (event.action === "end") {
        if (this.routingStartedAt !== null) {
          this.routingDurationMs = Math.max(0, Math.round(performance.now() - this.routingStartedAt));
        }
        this.usage.record(
          event.callId,
          "classifier",
          event.outcome === "success" ? bridgeUsage(event) : null,
          event.outcome === "success",
        );
      }
      this.track(this.store.appendEvent("model-call", { ...event }, {
        dedupeKey: `${event.callId}:${event.action}`,
      }));
      return;
    }
    if (event.type === "decision" && event.decision) {
      this.decision = event.decision;
      this.decisionObservation = event.action === "restored" ? "resumed-selection" : "persisted";
      this.track(this.store.recordDecision(event.decision, this.decisionObservation));
      return;
    }
    if (event.type === "auth_status") {
      this.track(this.store.appendEvent("auth", event));
      return;
    }
    if (event.type === "routing_error") {
      if (event.executionStatus) {
        this.limitFailure ??= { status: event.executionStatus, category: event.executionStatus };
      }
      this.lastError = errorStatus(event.message);
      this.track(this.store.appendEvent("error", {
        category: this.lastError.category,
        message: event.message,
      }));
      return;
    }
    this.track(this.store.appendEvent("routing", event));
  }

  recordAuthEvent(event: {
    action: "login" | "refresh";
    outcome: "success" | "error";
  }): void {
    this.track(this.store.appendEvent("auth", event));
  }

  private selectedModel(): Model<Api> | null {
    if (!this.decision) return null;
    return this.decision.selectedTier === "weak" ? this.options.roles.weak : this.options.roles.strong;
  }

  private recordAssistantMessage(message: AssistantMessage, callId: string): void {
    const expected = this.selectedModel();
    if (
      expected &&
      (message.provider !== expected.provider || message.model !== expected.id)
    ) {
      this.lastError = { status: "harness-error", category: "model-identity-mismatch" };
      throw new Error(
        `Invalid measurement: Pi served ${message.provider}/${message.model} outside the fixed selection ${expected.provider}/${expected.id}`,
      );
    }
    const identity = {
      provider: message.provider,
      model: message.model,
      providerReportedModelId: message.responseModel ?? null,
    };
    if (
      this.servedModel &&
      (this.servedModel.provider !== identity.provider || this.servedModel.model !== identity.model)
    ) {
      this.lastError = { status: "harness-error", category: "model-identity-mismatch" };
      throw new Error("Invalid measurement: coding calls were served by multiple Pi model identities");
    }
    this.servedModel = identity;
    const complete = !["pending", "error", "aborted", "deferred"].includes(message.stopReason);
    this.usage.record(callId, "coding", normalizeUsage(message.usage), complete);
    if (!complete && message.errorMessage) this.lastError = errorStatus(message.errorMessage, "provider-error");
    this.track(this.store.appendEvent("model-call", {
      action: "end",
      role: "coding",
      callId,
      outcome: complete ? "success" : message.stopReason,
      servedModel: identity,
      usage: normalizeUsage(message.usage),
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    }, { dedupeKey: callId, decisionId: this.decision?.decisionId ?? null }));
  }

  extension(): InlineExtension {
    return {
      name: "routing-lab-run-artifacts",
      hidden: true,
      factory: (pi) => {
        const pendingCalls: Array<{ callId: string; role: "coding" | "compaction" }> = [];
        let compactionActive = false;
        pi.on("before_agent_start", () => {
          this.agentStartedAt ??= performance.now();
          this.track(this.store.appendEvent("lifecycle", { action: "agent-start" }));
        });
        pi.on("before_provider_request", (_event, context) => {
          const role = compactionActive ? "compaction" : "coding";
          const callId = randomUUID();
          pendingCalls.push({ callId, role });
          this.track(this.store.appendEvent("model-call", {
            action: "start",
            role,
            callId,
            requestedModel: context.model
              ? { provider: context.model.provider, model: context.model.id }
              : null,
          }, { dedupeKey: `${callId}:start`, decisionId: this.decision?.decisionId ?? null }));
        });
        pi.on("message_end", (event, context) => {
          if (event.message.role !== "assistant") return;
          try {
            const pendingIndex = pendingCalls.findIndex((call) => call.role === "coding");
            const pending = pendingIndex === -1 ? undefined : pendingCalls.splice(pendingIndex, 1)[0];
            this.recordAssistantMessage(event.message, pending?.callId ?? randomUUID());
          } catch (error) {
            context.abort();
            throw error;
          }
        });
        pi.on("tool_execution_start", (event) => {
          this.track(this.store.appendEvent("tool", {
            action: "start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          }, { dedupeKey: `tool:${event.toolCallId}:start` }));
        });
        pi.on("tool_execution_end", (event) => {
          this.track(this.store.appendEvent("tool", {
            action: "end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
          }, { dedupeKey: `tool:${event.toolCallId}:end` }));
        });
        pi.on("session_before_compact", (event) => {
          compactionActive = true;
          this.track(this.store.appendEvent("lifecycle", {
            action: "compaction-start",
            reason: event.reason,
          }));
        });
        pi.on("session_compact", (event) => {
          const pendingIndex = pendingCalls.findIndex((call) => call.role === "compaction");
          const pending = pendingIndex === -1 ? undefined : pendingCalls.splice(pendingIndex, 1)[0];
          const usage = event.compactionEntry.usage
            ? normalizeUsage(event.compactionEntry.usage)
            : null;
          const callId = pending?.callId ?? `compaction:${event.compactionEntry.id}`;
          this.usage.record(callId, "compaction", usage);
          this.track(this.store.appendEvent("model-call", {
            action: "end",
            role: "compaction",
            callId,
            outcome: "success",
            usage,
          }, { dedupeKey: callId, decisionId: this.decision?.decisionId ?? null }));
          compactionActive = false;
        });
        pi.on("session_compact_failed", (event) => {
          const pendingIndex = pendingCalls.findIndex((call) => call.role === "compaction");
          const pending = pendingIndex === -1 ? undefined : pendingCalls.splice(pendingIndex, 1)[0];
          const callId = pending?.callId ?? randomUUID();
          this.usage.record(callId, "compaction", null, false);
          this.track(this.store.appendEvent("error", {
            category: event.aborted ? "cancelled" : "provider",
            action: "compaction-failed",
            reason: event.reason,
            ...(event.errorMessage ? { message: event.errorMessage } : {}),
          }));
          compactionActive = false;
        });
        pi.on("agent_settled", () => {
          if (this.agentStartedAt !== null) {
            this.agentDurationMs = (this.agentDurationMs ?? 0) + Math.max(0, Math.round(performance.now() - this.agentStartedAt));
            this.agentStartedAt = null;
          }
          this.track(this.store.appendEvent("lifecycle", { action: "agent-settled" }));
        });
        pi.on("session_shutdown", async (event) => {
          await this.store.appendEvent("lifecycle", {
            action: "session-shutdown",
            reason: event.reason,
          });
          await this.flush();
          if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
            await this.captureWorkspacePatch(this.options.workspace);
            await this.finalize();
          }
        });
      },
    };
  }

  async captureWorkspacePatch(workspace: string): Promise<void> {
    if (this.isFinalized) return;
    const execute = promisify(execFile);
    try {
      const { stdout } = await execute(
        "git",
        ["-C", workspace, "diff", "--binary", "--no-ext-diff", "--no-color", "--"],
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      await this.store.writePatch(stdout);
      this.patchCaptured = true;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (String(code) !== "128" && String(code) !== "129") throw error;
    }
  }

  async finalize(error?: unknown): Promise<RunResult> {
    if (this.finalizedResult) return this.finalizedResult;
    if (this.agentStartedAt !== null) {
      this.agentDurationMs = (this.agentDurationMs ?? 0) + Math.max(0, Math.round(performance.now() - this.agentStartedAt));
      this.agentStartedAt = null;
    }
    if (error !== undefined) {
      if (error instanceof ExecutionLimitError) {
        this.limitFailure ??= { status: error.status, category: error.status };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = errorStatus(message);
      await this.store.appendEvent("error", {
        category: this.lastError.category,
        message,
      });
    }
    await this.flush();
    const summaries = this.usage.summaries();
    const codingUsage = this.usage.summaryForRoles(["coding", "compaction"]);
    const selectedTier = this.decision?.selectedTier ?? (
      this.options.mode === "strong-only" ? "strong" : "weak"
    );
    const classifierCost = calculateRoleCost(
      this.options.config.models.classifier,
      summaries.classifier,
      referencePricing(this.options.roles.classifier),
    );
    const codingCost = calculateRoleCost(
      this.options.config.models[selectedTier],
      codingUsage,
      referencePricing(this.options.roles[selectedTier]),
    );
    const sumKnown = (left: number | null, right: number | null) =>
      left === null || right === null ? null : left + right;
    this.finalizedResult = await this.store.finalizeAttempt({
      executionStatus: this.limitFailure?.status ?? this.lastError?.status ?? "completed",
      errorCategory: this.limitFailure?.category ?? this.lastError?.category ?? null,
      decision: this.decision,
      decisionObservation: this.decisionObservation,
      servedModel: this.servedModel,
      routingDurationMs: this.routingDurationMs,
      agentDurationMs: this.agentDurationMs,
      usage: summaries,
      costs: {
        classifier: classifierCost,
        coding: codingCost,
        totalEstimatedCostUsd: sumKnown(
          classifierCost.estimatedCostUsd,
          codingCost.estimatedCostUsd,
        ),
        totalReferenceCostUsd: sumKnown(
          classifierCost.referenceCostUsd,
          codingCost.referenceCostUsd,
        ),
      },
      missingReasons: [
        ...(this.servedModel === null ? ["no completed coding model response was observed"] : []),
        ...(!this.patchCaptured ? ["workspace patch was unavailable because the project is not a Git worktree"] : []),
      ],
    });
    return this.finalizedResult;
  }
}
