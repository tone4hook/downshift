import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import type {
  AgentSession,
  ExtensionContext,
  InlineExtension,
  SessionManager,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SwitchyardBridgeClient } from "../bridge/client.js";
import type { BridgeDecision, ClassifierResult } from "../bridge/protocol.js";
import {
  configFingerprint,
  createLibraryPolicy,
  validateCodingCompatibility,
  type ConfigFingerprint,
  type LabConfig,
} from "../config/lab-config.js";
import {
  callClassifierThroughPi,
  resolvePiRoles,
  type ResolvedPiRoles,
} from "./runtime.js";
import { ExecutionLimitError, type ExecutionLimitStatus } from "./execution-failure.js";

export const ROUTING_DECISION_ENTRY = "routing-lab-decision";

export type SessionMode = "weak-only" | "strong-only" | "routed";
export type DecisionSource = "classifier" | "classifier-fallback" | "fixed-baseline";

export interface RoutingDecision {
  schemaVersion: 1;
  projectId: string;
  piSessionId: string;
  runId: string;
  decisionId: string;
  mode: SessionMode;
  selectedTier: "weak" | "strong";
  selectedModel: {
    provider: string;
    model: string;
    providerReportedModelId: string | null;
  };
  weakSolveProbability: number | null;
  threshold: number;
  source: DecisionSource;
  fallbackReason: "invalid_verdict" | null;
  classifier: {
    durationMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  fingerprint: ConfigFingerprint;
  authProfile: string;
  timestamp: string;
  missingReasons: string[];
}

export type SessionRoutingEvent =
  | { type: "execution_start"; sessionId: string }
  | {
      type: "session";
      action: "start";
      sessionId: string;
      reason: SessionStartEvent["reason"];
    }
  | {
      type: "decision";
      action: "pending" | "persisted" | "restored";
      sessionId: string;
      decision?: RoutingDecision;
    }
  | {
      type: "provider_call";
      role: "classifier";
      action: "start" | "end";
      callId: string;
      outcome?: "success" | "error";
      inputTokens?: number | null;
      outputTokens?: number | null;
      cacheReadTokens?: number | null;
      cacheWriteTokens?: number | null;
      reasoningTokens?: number | null;
      totalTokens?: number | null;
      provider?: string;
      model?: string;
      providerReportedModelId?: string | null;
    }
  | {
      type: "auth_status";
      provider: string;
      status: "available" | "required";
    }
  | {
      type: "model_lock";
      action: "selected" | "restored" | "rejected";
      provider: string;
      model: string;
    }
  | {
      type: "routing_error";
      sessionId: string;
      message: string;
      executionStatus?: ExecutionLimitStatus;
    };

export interface SessionRoutingOptions {
  config: LabConfig;
  authProfile: string;
  projectId: string;
  runId: string;
  runIdForSession?: (sessionId: string) => string;
  stateRoot: string;
  runtime: import("@earendil-works/pi-coding-agent").ModelRuntime;
  bridge: SwitchyardBridgeClient;
  mode: SessionMode;
  onEvent?: (event: SessionRoutingEvent) => void;
}

const hashPattern = "^[0-9a-f]{64}$";
export const ROUTING_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "projectId",
    "piSessionId",
    "runId",
    "decisionId",
    "mode",
    "selectedTier",
    "selectedModel",
    "weakSolveProbability",
    "threshold",
    "source",
    "fallbackReason",
    "classifier",
    "fingerprint",
    "authProfile",
    "timestamp",
    "missingReasons",
  ],
  properties: {
    schemaVersion: { const: 1 },
    projectId: { type: "string", minLength: 1 },
    piSessionId: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
    decisionId: { type: "string", minLength: 1 },
    mode: { enum: ["weak-only", "strong-only", "routed"] },
    selectedTier: { enum: ["weak", "strong"] },
    selectedModel: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "model", "providerReportedModelId"],
      properties: {
        provider: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        providerReportedModelId: { type: ["string", "null"] },
      },
    },
    weakSolveProbability: { type: ["number", "null"], minimum: 0, maximum: 1 },
    threshold: { type: "number", minimum: 0, maximum: 1 },
    source: { enum: ["classifier", "classifier-fallback", "fixed-baseline"] },
    fallbackReason: { enum: ["invalid_verdict", null] },
    classifier: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["durationMs", "inputTokens", "outputTokens"],
          properties: {
            durationMs: { type: "integer", minimum: 0 },
            inputTokens: { type: ["integer", "null"], minimum: 0 },
            outputTokens: { type: ["integer", "null"], minimum: 0 },
          },
        },
      ],
    },
    fingerprint: {
      type: "object",
      additionalProperties: false,
      required: [
        "value",
        "configHash",
        "modelMetadataHash",
        "providerConfigHash",
        "capabilityCardHash",
      ],
      properties: {
        value: { type: "string", pattern: hashPattern },
        configHash: { type: "string", pattern: hashPattern },
        modelMetadataHash: { type: "string", pattern: hashPattern },
        providerConfigHash: { type: "string", pattern: hashPattern },
        capabilityCardHash: { type: "string", pattern: hashPattern },
      },
    },
    authProfile: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" },
    timestamp: { type: "string", format: "date-time" },
    missingReasons: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

const ajv = new Ajv2020Module.default({ allErrors: true, strict: true });
ajv.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)));
const validateDecision = ajv.compile(ROUTING_DECISION_SCHEMA);

export function validateRoutingDecision(value: unknown, source: string): RoutingDecision {
  if (!validateDecision(value)) {
    throw new Error(`Invalid routing decision in ${source}: ${ajv.errorsText(validateDecision.errors)}`);
  }
  return structuredClone(value) as RoutingDecision;
}

function modelIdentity(model: Model<Api>): RoutingDecision["selectedModel"] {
  return {
    provider: model.provider,
    model: model.id,
    providerReportedModelId: null,
  };
}

function modelsMatch(left: Model<Api> | undefined, right: Model<Api>): boolean {
  return left?.provider === right.provider && left.id === right.id;
}

function decisionEquals(left: RoutingDecision, right: RoutingDecision): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasCodingHistory(sessionManager: Pick<SessionManager, "getEntries">): boolean {
  return sessionManager
    .getEntries()
    .some((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
}

export class RoutingDecisionStore {
  readonly directory: string;

  constructor(stateRoot: string) {
    this.directory = join(stateRoot, "routing-decisions");
  }

  pathFor(sessionId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      throw new Error("Pi session ID contains unsupported characters");
    }
    return join(this.directory, `${sessionId}.json`);
  }

  async read(sessionId: string): Promise<RoutingDecision | null> {
    const path = this.pathFor(sessionId);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`Routing decision is corrupt: ${path}`, { cause: error });
    }
    return validateRoutingDecision(parsed, path);
  }

  async write(decision: RoutingDecision): Promise<void> {
    validateRoutingDecision(decision, "pending routing decision");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const path = this.pathFor(decision.piSessionId);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(decision)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
  }
}

export class SessionRoutingController {
  readonly roles: ResolvedPiRoles;
  readonly fingerprint: ConfigFingerprint;
  readonly store: RoutingDecisionStore;
  lastError: string | null = null;
  limitError: ExecutionLimitError | null = null;
  private readonly policy;
  private activeSession: AgentSession | null = null;

  constructor(private readonly options: SessionRoutingOptions) {
    this.roles = resolvePiRoles(options.runtime, options.config.models);
    validateCodingCompatibility(options.config, this.roles);
    this.fingerprint = configFingerprint(
      options.config,
      this.roles,
      options.runtime,
      options.authProfile,
    );
    this.policy = createLibraryPolicy(options.config, this.roles);
    this.store = new RoutingDecisionStore(options.stateRoot);
  }

  async preflightAuth(): Promise<void> {
    for (const provider of new Set([
      this.roles.classifier.provider,
      this.roles.weak.provider,
      this.roles.strong.provider,
    ])) {
      const available = Boolean(await this.options.runtime.checkAuth(provider));
      this.options.onEvent?.({
        type: "auth_status",
        provider,
        status: available ? "available" : "required",
      });
      if (!available) {
        throw new Error(
          `Pi authentication is required for configured provider '${provider}'; use route-agent auth with profile '${this.options.authProfile}'`,
        );
      }
    }
  }

  attachSession(session: AgentSession): void {
    this.activeSession = session;
  }

  selectedModel(decision: RoutingDecision): Model<Api> {
    const model = decision.selectedTier === "weak" ? this.roles.weak : this.roles.strong;
    if (
      decision.selectedModel.provider !== model.provider ||
      decision.selectedModel.model !== model.id
    ) {
      throw new Error("Persisted routing decision does not match its selected Pi role");
    }
    return model;
  }

  async load(
    sessionManager: Pick<SessionManager, "getEntries" | "getSessionId">,
    reason: SessionStartEvent["reason"],
  ): Promise<RoutingDecision | null> {
    const sessionId = sessionManager.getSessionId();
    const customDecisions: RoutingDecision[] = [];
    for (const entry of sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ROUTING_DECISION_ENTRY) {
        customDecisions.push(validateRoutingDecision(entry.data, `Pi custom entry ${customDecisions.length + 1}`));
      }
    }
    const ownCustom = customDecisions.filter((decision) => decision.piSessionId === sessionId);
    if (ownCustom.length > 1 || (ownCustom.length === 1 && customDecisions.some(
      (decision) =>
        decision.piSessionId === sessionId &&
        decision.decisionId !== ownCustom[0]?.decisionId,
    ))) {
      throw new Error(`Pi session ${sessionId} contains conflicting routing decisions`);
    }

    const stored = await this.store.read(sessionId);
    if (reason === "new" || reason === "fork") {
      if (stored) throw new Error(`Fresh Pi session ${sessionId} unexpectedly has a routing decision`);
      return null;
    }
    if (!stored) {
      if (ownCustom.length > 0 || hasCodingHistory(sessionManager)) {
        throw new Error(`Routing decision is missing for existing Pi session ${sessionId}`);
      }
      return null;
    }
    if (stored.projectId !== this.options.projectId || stored.piSessionId !== sessionId) {
      throw new Error("Persisted routing decision belongs to a different project or Pi session");
    }
    if (stored.authProfile !== this.options.authProfile || stored.fingerprint.value !== this.fingerprint.value) {
      throw new Error(
        "Persisted routing decision does not match the selected auth profile or model/provider configuration",
      );
    }
    if (stored.mode !== this.options.mode) {
      throw new Error(`Persisted routing decision mode is '${stored.mode}', not '${this.options.mode}'`);
    }
    if (ownCustom.length === 0 && hasCodingHistory(sessionManager)) {
      throw new Error(`Pi session ${sessionId} is missing its routing decision custom entry`);
    }
    if (ownCustom[0] && !decisionEquals(ownCustom[0], stored)) {
      throw new Error(`Pi session ${sessionId} has a routing decision that conflicts with durable state`);
    }
    return stored;
  }

  async create(task: string, sessionId: string, signal?: AbortSignal): Promise<RoutingDecision> {
    await this.preflightAuth();
    const startedAt = Date.now();
    let bridgeDecision: BridgeDecision | null = null;
    let classifierUsage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          reasoningTokens?: number;
          totalTokens?: number;
        }
      | undefined;
    let classifierIdentity:
      | {
          provider: string;
          model: string;
          providerReportedModelId: string | null;
        }
      | undefined;
    if (this.options.mode === "routed") {
      const classifierCallId = randomUUID();
      this.options.onEvent?.({
        type: "provider_call",
        role: "classifier",
        action: "start",
        callId: classifierCallId,
      });
      try {
        bridgeDecision = await this.options.bridge.resolveDecision({
          decisionId: randomUUID(),
          task,
          weakThreshold: this.policy.weakThreshold,
          weakCapabilityDescription: this.policy.weakCapabilityDescription,
          maxOutputTokens: this.policy.maxOutputTokens,
          ...(signal === undefined ? {} : { signal }),
          callClassifier: async (request) => {
            const result: ClassifierResult = await callClassifierThroughPi(
              this.options.runtime,
              this.roles.classifier,
              request,
              {
                requestTimeoutMs: this.options.config.execution.requestTimeoutSeconds * 1000,
                ...(signal === undefined ? {} : { signal }),
              },
            );
            if (!("error" in result)) {
              classifierUsage = result.usage;
              if (result.provider && result.model) {
                classifierIdentity = {
                  provider: result.provider,
                  model: result.model,
                  providerReportedModelId: result.providerReportedModelId ?? null,
                };
              }
            }
            return result;
          },
        });
        this.options.onEvent?.({
          type: "provider_call",
          role: "classifier",
          action: "end",
          callId: classifierCallId,
          outcome: "success",
          ...(
            classifierUsage
              ? {
                  inputTokens: classifierUsage.inputTokens ?? null,
                  outputTokens: classifierUsage.outputTokens ?? null,
                  cacheReadTokens: classifierUsage.cacheReadTokens ?? null,
                  cacheWriteTokens: classifierUsage.cacheWriteTokens ?? null,
                  reasoningTokens: classifierUsage.reasoningTokens ?? null,
                  totalTokens: classifierUsage.totalTokens ?? null,
                  ...(classifierIdentity ?? {}),
                }
              : {}
          ),
        });
      } catch (error) {
        this.options.onEvent?.({
          type: "provider_call",
          role: "classifier",
          action: "end",
          callId: classifierCallId,
          outcome: "error",
        });
        throw error;
      }
    }

    const selectedTier =
      this.options.mode === "weak-only"
        ? "weak"
        : this.options.mode === "strong-only"
          ? "strong"
          : bridgeDecision!.selectedAlias;
    const selected = selectedTier === "weak" ? this.roles.weak : this.roles.strong;
    const validated =
      bridgeDecision?.evidence.kind === "validated_verdict" ? bridgeDecision.evidence : null;
    const fallback = bridgeDecision?.evidence.kind === "fallback" ? bridgeDecision.evidence : null;
    const usage = classifierUsage;
    const decision: RoutingDecision = {
      schemaVersion: 1,
      projectId: this.options.projectId,
      piSessionId: sessionId,
      runId: this.options.runIdForSession?.(sessionId) ?? this.options.runId,
      decisionId: bridgeDecision?.decisionId ?? randomUUID(),
      mode: this.options.mode,
      selectedTier,
      selectedModel: modelIdentity(selected),
      weakSolveProbability: validated?.weakSolveProbability ?? null,
      threshold: this.options.config.routing.weakThreshold,
      source:
        this.options.mode !== "routed"
          ? "fixed-baseline"
          : fallback
            ? "classifier-fallback"
            : "classifier",
      fallbackReason: fallback?.reason ?? null,
      classifier:
        this.options.mode === "routed"
          ? {
              durationMs: Date.now() - startedAt,
              inputTokens: usage?.inputTokens ?? null,
              outputTokens: usage?.outputTokens ?? null,
            }
          : null,
      fingerprint: this.fingerprint,
      authProfile: this.options.authProfile,
      timestamp: new Date().toISOString(),
      missingReasons: [
        "selectedModel.providerReportedModelId is unavailable from the Pi 0.85.0 generic response",
        ...(validated ? [] : ["weakSolveProbability is unavailable without a validated classifier verdict"]),
        ...(this.options.mode === "routed" && usage === undefined
          ? ["classifier token usage was not reported"]
          : []),
      ],
    };
    await this.store.write(decision);
    return decision;
  }

  extension(): InlineExtension {
    return {
      name: "routing-lab-session-guard",
      hidden: true,
      factory: (pi) => {
        let current: RoutingDecision | null = null;
        let repairingModel = false;
        let startupError: string | null = null;
        let runTimer: NodeJS.Timeout | undefined;
        let runAbort: AbortController | undefined;
        let requestTimer: NodeJS.Timeout | undefined;
        let turnCount = 0;

        const stopForLimit = (context: ExtensionContext, status: ExecutionLimitStatus, message: string) => {
          this.limitError ??= new ExecutionLimitError(status, message);
          this.lastError = this.limitError.message;
          this.options.onEvent?.({ type: "routing_error", sessionId: context.sessionManager.getSessionId(),
            message: this.limitError.message, executionStatus: this.limitError.status });
          runAbort?.abort(this.limitError);
          context.abort();
        };

        const clearRequestTimer = () => {
          if (requestTimer) clearTimeout(requestTimer);
          requestTimer = undefined;
        };

        const startRequestTimer = (
          context: ExtensionContext,
          role: "coding" | "compaction",
        ) => {
          clearRequestTimer();
          requestTimer = setTimeout(() => {
            const message =
              `${role} provider request exceeded ` +
              `requestTimeoutSeconds=${this.options.config.execution.requestTimeoutSeconds}`;
            stopForLimit(context, "timeout", message);
          }, this.options.config.execution.requestTimeoutSeconds * 1000);
          requestTimer.unref();
        };

        const displayStatus = (
          context: ExtensionContext,
          state: "pending" | "selected" | "resumed",
        ) => {
          if (context.mode !== "tui") return;
          if (!current) {
            context.ui.setStatus("routing-lab", "routing: pending");
            return;
          }
          const evidence =
            current.weakSolveProbability === null
              ? current.fallbackReason ?? "confidence unavailable"
              : `p=${current.weakSolveProbability.toFixed(3)}`;
          const billing = this.options.config.models[current.selectedTier].billing;
          context.ui.setStatus(
            "routing-lab",
            `routing: ${state} ${current.selectedTier} ${current.selectedModel.provider}/${current.selectedModel.model} ${evidence} threshold=${current.threshold.toFixed(3)} billing=${billing} (not measured spend)`,
          );
        };

        const applySelectedModel = async (
          context: ExtensionContext,
          action: "selected" | "restored",
        ) => {
          if (!current) throw new Error("Routing decision is unavailable");
          const selected = this.selectedModel(current);
          if (!modelsMatch(context.model, selected)) {
            const applied = await pi.setModel(selected);
            if (!applied) {
              throw new Error(
                `Pi authentication is required to restore ${selected.provider}/${selected.id} in profile '${this.options.authProfile}'`,
              );
            }
          }
          if (this.activeSession?.sessionId === context.sessionManager.getSessionId()) {
            this.activeSession.setScopedModels([{ model: selected, thinkingLevel: "off" }]);
          }
          this.options.onEvent?.({
            type: "model_lock",
            action,
            provider: selected.provider,
            model: selected.id,
          });
        };

        pi.on("session_start", async (event, context) => {
          this.options.onEvent?.({
            type: "session",
            action: "start",
            sessionId: context.sessionManager.getSessionId(),
            reason: event.reason,
          });
          try {
            current = await this.load(context.sessionManager, event.reason);
          } catch (error) {
            startupError = error instanceof Error ? error.message : String(error);
            this.lastError = startupError;
            this.options.onEvent?.({
              type: "routing_error",
              sessionId: context.sessionManager.getSessionId(),
              message: startupError,
            });
            if (context.mode === "tui") {
              context.ui.setStatus("routing-lab", "routing: blocked");
              context.ui.notify(startupError, "error");
            }
            return;
          }
          if (current) {
            try {
              await this.preflightAuth();
              await applySelectedModel(context, "restored");
              this.options.onEvent?.({
                type: "decision",
                action: "restored",
                sessionId: current.piSessionId,
                decision: current,
              });
              displayStatus(context, "resumed");
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.lastError = message;
              this.options.onEvent?.({
                type: "routing_error",
                sessionId: context.sessionManager.getSessionId(),
                message,
              });
              if (context.mode === "tui") context.ui.notify(message, "error");
            }
            return;
          }
          this.options.onEvent?.({
            type: "decision",
            action: "pending",
            sessionId: context.sessionManager.getSessionId(),
          });
          displayStatus(context, "pending");
        });

        pi.on("input", async (event, context) => {
          if (startupError) {
            if (context.hasUI) context.ui.notify(startupError, "error");
            return { action: "handled" as const };
          }
          this.lastError = null;
          this.limitError = null;
          this.options.onEvent?.({ type: "execution_start", sessionId: context.sessionManager.getSessionId() });
          const timeoutMs = this.options.config.execution.timeoutSeconds * 1000;
          runAbort?.abort();
          if (runTimer) clearTimeout(runTimer);
          runAbort = new AbortController();
          const startedAt = Date.now();
          runTimer = setTimeout(() => {
            stopForLimit(context, "timeout", "Session wall-time limit exceeded");
          }, timeoutMs);
          runTimer.unref();

          try {
            if (!current) {
              current = await this.create(event.text, context.sessionManager.getSessionId(), runAbort.signal);
              pi.appendEntry(ROUTING_DECISION_ENTRY, current);
              await applySelectedModel(context, "selected");
              this.options.onEvent?.({
                type: "decision",
                action: "persisted",
                sessionId: current.piSessionId,
                decision: current,
              });
            } else {
              await this.preflightAuth();
              await applySelectedModel(context, "restored");
            }
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs >= timeoutMs) {
              stopForLimit(context, "timeout", "Session wall-time limit exceeded during routing");
              throw this.limitError;
            }
            displayStatus(context, "selected");
            turnCount = 0;
            return { action: "continue" as const };
          } catch (error) {
            if (error instanceof ExecutionLimitError) stopForLimit(context, error.status, error.message);
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = message;
            this.options.onEvent?.({
              type: "routing_error",
              sessionId: context.sessionManager.getSessionId(),
              message,
            });
            if (runTimer) clearTimeout(runTimer);
            runTimer = undefined;
            runAbort = undefined;
            if (context.hasUI) context.ui.notify(message, "error");
            return { action: "handled" as const };
          }
        });

        pi.on("before_agent_start", (_event, context) => {
          if (!current) {
            const message = "Pi coding was blocked because no routing decision is active";
            this.lastError = message;
            context.abort();
          }
        });

        pi.on("turn_start", (_event, context) => {
          turnCount += 1;
          if (turnCount > this.options.config.execution.maxAgentTurns) {
            stopForLimit(context, "budget-exhausted",
              `Pi session exceeded maxAgentTurns=${this.options.config.execution.maxAgentTurns}`);
            throw this.limitError;
          }
          startRequestTimer(context, "coding");
        });

        pi.on("message_end", (event) => {
          if (event.message.role === "assistant") clearRequestTimer();
        });

        pi.on("turn_end", () => {
          clearRequestTimer();
        });

        pi.on("agent_settled", () => {
          clearRequestTimer();
          if (runTimer) clearTimeout(runTimer);
          runTimer = undefined;
          runAbort = undefined;
        });

        pi.on("session_before_compact", async (_event, context) => {
          if (startupError || !current) return { cancel: true };
          try {
            await this.preflightAuth();
            await applySelectedModel(context, "restored");
            startRequestTimer(context, "compaction");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = message;
            if (context.hasUI) context.ui.notify(message, "error");
            return { cancel: true };
          }
        });

        pi.on("session_compact", clearRequestTimer);
        pi.on("session_compact_failed", clearRequestTimer);

        pi.on("before_provider_request", (_event, context) => {
          if (this.limitError) throw this.limitError;
          if (!current) {
            throw new Error("Pi provider request was blocked before a routing decision was persisted");
          }
          const selected = this.selectedModel(current);
          if (!modelsMatch(context.model, selected)) {
            throw new Error(
              `Pi provider request was blocked because ${context.model?.provider ?? "unknown"}/${context.model?.id ?? "unknown"} is outside the session model lock`,
            );
          }
        });

        pi.on("model_select", async (event, context) => {
          if (!current || repairingModel) return;
          const selected = this.selectedModel(current);
          if (modelsMatch(event.model, selected)) return;
          repairingModel = true;
          try {
            this.options.onEvent?.({
              type: "model_lock",
              action: "rejected",
              provider: event.model.provider,
              model: event.model.id,
            });
            if (context.hasUI) {
              context.ui.notify(
                `This lab session is locked to ${selected.provider}/${selected.id}; use /new to obtain a new routing decision.`,
                "warning",
              );
            }
            const applied = await pi.setModel(selected);
            if (!applied) {
              throw new Error(
                `Pi authentication is required to restore locked model ${selected.provider}/${selected.id}`,
              );
            }
          } finally {
            repairingModel = false;
          }
        });

        pi.on("session_shutdown", () => {
          if (runTimer) clearTimeout(runTimer);
          runAbort?.abort();
        });
      },
    };
  }
}
