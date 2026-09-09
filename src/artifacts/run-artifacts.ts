import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import type { LabConfig } from "../config/lab-config.js";
import {
  ROUTING_DECISION_SCHEMA,
  validateRoutingDecision,
  type RoutingDecision,
  type SessionMode,
} from "../pi/session-routing.js";
import type { RoleCost, UsageRole, UsageSummary } from "./usage.js";

export type EvidenceKind = "mock" | "live" | "replay";
export type ExecutionStatus =
  | "completed"
  | "timeout"
  | "cancelled"
  | "provider-error"
  | "auth-required"
  | "rate-limited"
  | "harness-error"
  | "budget-exhausted";

export interface AttemptIdentity {
  projectId: string;
  piSessionId: string;
  runId: string;
  attemptId: string;
  decisionId: string | null;
  experimentId: string | null;
  taskId: string | null;
  repetition: number | null;
}

export type RunEventKind =
  | "startup"
  | "routing"
  | "model-call"
  | "tool"
  | "auth"
  | "lifecycle"
  | "error"
  | "finalization";

export interface RunEvent {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  identity: AttemptIdentity;
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

export interface RunProvenance {
  labRevision: string | null;
  labDirty: boolean | null;
  piVersion: string;
  switchyardRevision: string;
  agentImageId: string | null;
  configHash: string;
  capabilityCardHash: string;
  modelMetadataHash: string;
  providerConfigHash: string;
  authProfile: string;
  mode: SessionMode;
  limits: LabConfig["execution"];
  models: {
    classifier: { provider: string; model: string; metadataHash: string };
    weak: { provider: string; model: string; metadataHash: string };
    strong: { provider: string; model: string; metadataHash: string };
  };
  taskHash: string | null;
  sourceHash: string | null;
  validatorHash: string | null;
  previousAttemptId?: string | null;
}

export interface RunResult {
  schemaVersion: 1;
  identity: AttemptIdentity;
  evidenceKind: EvidenceKind;
  mode: SessionMode;
  decision: RoutingDecision | null;
  decisionObservation: "persisted" | "resumed-selection" | null;
  servedModel: {
    provider: string;
    model: string;
    providerReportedModelId: string | null;
  } | null;
  execution: {
    status: ExecutionStatus;
    startedAt: string;
    endedAt: string | null;
    errorCategory: string | null;
  };
  validation: {
    status: "pass" | "fail" | "error" | "not-run";
    checks: ValidationCheckResult[];
  };
  durationsMs: {
    setup: number;
    routing: number | null;
    agent: number | null;
    validation: number | null;
  };
  usage: Record<UsageRole | "total", UsageSummary>;
  costs: {
    classifier: RoleCost;
    coding: RoleCost;
    totalEstimatedCostUsd: number | null;
    totalReferenceCostUsd: number | null;
  };
  provenance: RunProvenance;
  artifacts: {
    events: string;
    patch: string;
  };
  missingReasons: string[];
}

export interface ValidationCheckResult {
  name: string;
  status: "pass" | "fail" | "error" | "not-run";
  exitCode: number | null;
  durationMs: number;
  stdoutArtifact: string | null;
  stderrArtifact: string | null;
  reason: string | null;
}

export interface IndependentValidationResult {
  status: RunResult["validation"]["status"];
  checks: ValidationCheckResult[];
  durationMs: number | null;
}

export interface FinalizeAttemptInput {
  executionStatus: ExecutionStatus;
  endedAt?: string | null;
  errorCategory?: string | null;
  decision: RoutingDecision | null;
  decisionObservation: RunResult["decisionObservation"];
  servedModel: RunResult["servedModel"];
  routingDurationMs: number | null;
  agentDurationMs: number | null;
  usage: RunResult["usage"];
  costs: RunResult["costs"];
  missingReasons?: string[];
}

export interface AttemptRead {
  status: "finalized" | "incomplete";
  result: RunResult | null;
  events: RunEvent[];
  truncatedTail: boolean;
}

export interface StartAttemptOptions {
  stateRoot: string;
  collection?: "runs" | "attempts";
  identity: Omit<AttemptIdentity, "decisionId">;
  evidenceKind: EvidenceKind;
  mode: SessionMode;
  provenance: RunProvenance;
  startedAt?: string;
  setupDurationMs?: number;
}

const hashPattern = "^[0-9a-f]{64}$";
const nullableHash = { type: ["string", "null"], pattern: hashPattern } as const;
const nullableRevision = { type: ["string", "null"], pattern: "^[0-9a-f]{40}$" } as const;
const identitySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "projectId",
    "piSessionId",
    "runId",
    "attemptId",
    "decisionId",
    "experimentId",
    "taskId",
    "repetition",
  ],
  properties: {
    projectId: { type: "string", minLength: 1 },
    piSessionId: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
    attemptId: { type: "string", minLength: 1 },
    decisionId: { type: ["string", "null"], minLength: 1 },
    experimentId: { type: ["string", "null"], minLength: 1 },
    taskId: { type: ["string", "null"], minLength: 1 },
    repetition: { type: ["integer", "null"], minimum: 0 },
  },
} as const;

const eventPayloadSchemas = {
  startup: {
    type: "object",
    additionalProperties: false,
    required: ["mode", "evidenceKind", "authProfile", "configHash"],
    properties: {
      mode: { enum: ["weak-only", "strong-only", "routed"] },
      evidenceKind: { enum: ["mock", "live", "replay"] },
      authProfile: { type: "string" },
      configHash: { type: "string", pattern: hashPattern },
    },
  },
  routing: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      type: { enum: ["session", "decision", "model_lock"] },
      action: {
        enum: [
          "start",
          "pending",
          "persisted",
          "restored",
          "selected",
          "rejected",
          "decision-recorded",
        ],
      },
      sessionId: { type: "string" },
      reason: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      observation: { enum: ["persisted", "resumed-selection"] },
      decision: ROUTING_DECISION_SCHEMA,
    },
  },
  "model-call": {
    type: "object",
    additionalProperties: false,
    required: ["action", "role", "callId"],
    properties: {
      type: { const: "provider_call" },
      action: { enum: ["start", "end"] },
      role: { enum: ["classifier", "coding", "compaction"] },
      callId: { type: "string", minLength: 1 },
      outcome: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      providerReportedModelId: { type: ["string", "null"] },
      inputTokens: { type: ["integer", "null"], minimum: 0 },
      outputTokens: { type: ["integer", "null"], minimum: 0 },
      cacheReadTokens: { type: ["integer", "null"], minimum: 0 },
      cacheWriteTokens: { type: ["integer", "null"], minimum: 0 },
      reasoningTokens: { type: ["integer", "null"], minimum: 0 },
      totalTokens: { type: ["integer", "null"], minimum: 0 },
      requestedModel: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["provider", "model"],
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
        },
      },
      servedModel: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "model", "providerReportedModelId"],
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          providerReportedModelId: { type: ["string", "null"] },
        },
      },
      usage: {
        type: ["object", "null"],
        additionalProperties: false,
        required: [
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
          "reasoningTokens",
          "totalTokens",
          "semantics",
        ],
        properties: {
          inputTokens: { type: "integer", minimum: 0 },
          outputTokens: { type: "integer", minimum: 0 },
          cacheReadTokens: { type: "integer", minimum: 0 },
          cacheWriteTokens: { type: "integer", minimum: 0 },
          reasoningTokens: { type: ["integer", "null"], minimum: 0 },
          totalTokens: { type: "integer", minimum: 0 },
          semantics: { const: "pi-exclusive-categories" },
        },
      },
      errorMessage: { type: "string" },
    },
  },
  tool: {
    type: "object",
    additionalProperties: false,
    required: ["action", "toolCallId", "toolName"],
    properties: {
      action: { enum: ["start", "end"] },
      toolCallId: { type: "string", minLength: 1 },
      toolName: { type: "string", minLength: 1 },
      isError: { type: "boolean" },
    },
  },
  auth: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: "auth_status" },
      action: { enum: ["login", "refresh"] },
      outcome: { enum: ["success", "error"] },
      provider: { type: "string" },
      status: { enum: ["available", "required"] },
    },
    anyOf: [
      { required: ["type", "provider", "status"] },
      { required: ["action", "outcome"] },
    ],
  },
  lifecycle: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        enum: [
          "agent-start",
          "agent-settled",
          "compaction-start",
          "session-shutdown",
        ],
      },
      reason: { type: "string" },
    },
  },
  error: {
    type: "object",
    additionalProperties: false,
    required: ["category"],
    properties: {
      category: { type: "string", minLength: 1 },
      action: { type: "string" },
      reason: { type: "string" },
      message: { type: "string" },
    },
  },
  finalization: {
    type: "object",
    additionalProperties: false,
    required: ["status", "validationStatus"],
    properties: {
      status: { type: "string" },
      validationStatus: { const: "not-run" },
    },
  },
} as const;

export const RUN_EVENT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "sequence", "timestamp", "identity", "kind", "payload"],
  properties: {
    schemaVersion: { const: 1 },
    sequence: { type: "integer", minimum: 1 },
    timestamp: { type: "string", format: "date-time" },
    identity: identitySchema,
    kind: {
      enum: ["startup", "routing", "model-call", "tool", "auth", "lifecycle", "error", "finalization"],
    },
    payload: { type: "object" },
  },
  allOf: Object.entries(eventPayloadSchemas).map(([kind, payload]) => ({
    if: { properties: { kind: { const: kind } }, required: ["kind"] },
    then: { properties: { payload } },
  })),
} as const;

const usageSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "observedCalls",
    "missingCalls",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens",
    "semantics",
    "missingReasons",
  ],
  properties: {
    status: { enum: ["complete", "partial", "unknown"] },
    observedCalls: { type: "integer", minimum: 0 },
    missingCalls: { type: "integer", minimum: 0 },
    inputTokens: { type: ["integer", "null"], minimum: 0 },
    outputTokens: { type: ["integer", "null"], minimum: 0 },
    cacheReadTokens: { type: ["integer", "null"], minimum: 0 },
    cacheWriteTokens: { type: ["integer", "null"], minimum: 0 },
    reasoningTokens: { type: ["integer", "null"], minimum: 0 },
    totalTokens: { type: ["integer", "null"], minimum: 0 },
    semantics: { const: "pi-exclusive-categories" },
    missingReasons: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

const roleCostSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "billing",
    "currency",
    "pricingAsOf",
    "estimatedCostUsd",
    "referenceCostUsd",
    "missingReasons",
  ],
  properties: {
    billing: { enum: ["unknown", "subscription", "per-token"] },
    currency: { enum: ["USD", null] },
    pricingAsOf: { type: ["string", "null"] },
    estimatedCostUsd: { type: ["number", "null"], minimum: 0 },
    referenceCostUsd: { type: ["number", "null"], minimum: 0 },
    missingReasons: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export const RUN_RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "identity",
    "evidenceKind",
    "mode",
    "decision",
    "decisionObservation",
    "servedModel",
    "execution",
    "validation",
    "durationsMs",
    "usage",
    "costs",
    "provenance",
    "artifacts",
    "missingReasons",
  ],
  properties: {
    schemaVersion: { const: 1 },
    identity: identitySchema,
    evidenceKind: { enum: ["mock", "live", "replay"] },
    mode: { enum: ["weak-only", "strong-only", "routed"] },
    decision: { anyOf: [{ type: "null" }, ROUTING_DECISION_SCHEMA] },
    decisionObservation: { enum: ["persisted", "resumed-selection", null] },
    servedModel: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["provider", "model", "providerReportedModelId"],
          properties: {
            provider: { type: "string", minLength: 1 },
            model: { type: "string", minLength: 1 },
            providerReportedModelId: { type: ["string", "null"] },
          },
        },
      ],
    },
    execution: {
      type: "object",
      additionalProperties: false,
      required: ["status", "startedAt", "endedAt", "errorCategory"],
      properties: {
        status: {
          enum: [
            "completed",
            "timeout",
            "cancelled",
            "provider-error",
            "auth-required",
            "rate-limited",
            "harness-error",
            "budget-exhausted",
          ],
        },
        startedAt: { type: "string", format: "date-time" },
        endedAt: { type: ["string", "null"], format: "date-time" },
        errorCategory: { type: ["string", "null"] },
      },
    },
    validation: {
      type: "object",
      additionalProperties: false,
      required: ["status", "checks"],
      properties: {
        status: { enum: ["pass", "fail", "error", "not-run"] },
        checks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "name",
              "status",
              "exitCode",
              "durationMs",
              "stdoutArtifact",
              "stderrArtifact",
              "reason",
            ],
            properties: {
              name: { type: "string", minLength: 1 },
              status: { enum: ["pass", "fail", "error", "not-run"] },
              exitCode: { type: ["integer", "null"] },
              durationMs: { type: "integer", minimum: 0 },
              stdoutArtifact: { type: ["string", "null"] },
              stderrArtifact: { type: ["string", "null"] },
              reason: { type: ["string", "null"] },
            },
          },
        },
      },
    },
    durationsMs: {
      type: "object",
      additionalProperties: false,
      required: ["setup", "routing", "agent", "validation"],
      properties: {
        setup: { type: "integer", minimum: 0 },
        routing: { type: ["integer", "null"], minimum: 0 },
        agent: { type: ["integer", "null"], minimum: 0 },
        validation: { type: ["integer", "null"], minimum: 0 },
      },
    },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["classifier", "coding", "compaction", "total"],
      properties: {
        classifier: usageSummarySchema,
        coding: usageSummarySchema,
        compaction: usageSummarySchema,
        total: usageSummarySchema,
      },
    },
    costs: {
      type: "object",
      additionalProperties: false,
      required: ["classifier", "coding", "totalEstimatedCostUsd", "totalReferenceCostUsd"],
      properties: {
        classifier: roleCostSchema,
        coding: roleCostSchema,
        totalEstimatedCostUsd: { type: ["number", "null"], minimum: 0 },
        totalReferenceCostUsd: { type: ["number", "null"], minimum: 0 },
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: [
        "labRevision",
        "labDirty",
        "piVersion",
        "switchyardRevision",
        "agentImageId",
        "configHash",
        "capabilityCardHash",
        "modelMetadataHash",
        "providerConfigHash",
        "authProfile",
        "mode",
        "limits",
        "models",
        "taskHash",
        "sourceHash",
        "validatorHash",
      ],
      properties: {
        labRevision: nullableRevision,
        labDirty: { type: ["boolean", "null"] },
        piVersion: { type: "string", minLength: 1 },
        switchyardRevision: { type: "string", pattern: "^[0-9a-f]{40}$" },
        agentImageId: { type: ["string", "null"], minLength: 1 },
        configHash: { type: "string", pattern: hashPattern },
        capabilityCardHash: { type: "string", pattern: hashPattern },
        modelMetadataHash: { type: "string", pattern: hashPattern },
        providerConfigHash: { type: "string", pattern: hashPattern },
        authProfile: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" },
        mode: { enum: ["weak-only", "strong-only", "routed"] },
        limits: {
          type: "object",
          additionalProperties: false,
          required: [
            "maxAgentTurns",
            "timeoutSeconds",
            "requestTimeoutSeconds",
            "validationTimeoutSeconds",
            "contextTokenCap",
            "maxOutputTokens",
            "thinking",
          ],
          properties: {
            maxAgentTurns: { type: "integer", minimum: 1 },
            timeoutSeconds: { type: "integer", minimum: 1 },
            requestTimeoutSeconds: { type: "integer", minimum: 1 },
            validationTimeoutSeconds: { type: "integer", minimum: 1 },
            contextTokenCap: { type: "integer", minimum: 1 },
            maxOutputTokens: { type: "integer", minimum: 1 },
            thinking: { const: "off" },
          },
        },
        models: {
          type: "object",
          additionalProperties: false,
          required: ["classifier", "weak", "strong"],
          properties: Object.fromEntries(
            ["classifier", "weak", "strong"].map((role) => [
              role,
              {
                type: "object",
                additionalProperties: false,
                required: ["provider", "model", "metadataHash"],
                properties: {
                  provider: { type: "string", minLength: 1 },
                  model: { type: "string", minLength: 1 },
                  metadataHash: { type: "string", pattern: hashPattern },
                },
              },
            ]),
          ),
        },
        taskHash: nullableHash,
        sourceHash: nullableHash,
        validatorHash: nullableHash,
        previousAttemptId: {
          type: ["string", "null"],
          pattern: "^[a-z0-9][a-z0-9-]*$",
        },
      },
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      required: ["events", "patch"],
      properties: {
        events: { type: "string", minLength: 1 },
        patch: { type: "string", minLength: 1 },
      },
    },
    missingReasons: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
  },
} as const;

const ajv = new Ajv2020Module.default({ allErrors: true, strict: false });
ajv.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)));
const validateEvent = ajv.compile(RUN_EVENT_SCHEMA);
const validateResult = ajv.compile(RUN_RESULT_SCHEMA);

const sensitiveKey =
  /(?:^|[-_])(auth|authorization|credential|secret|token|api[-_]?key|account|oauth|cookie|password|code)(?:$|[-_])/i;
const sensitiveTextPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:oauth[-_]?code|device[-_]?code)\s*[:=]\s*[^\s,;]+/gi,
];

export function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    return sensitiveTextPatterns.reduce(
      (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
      value,
    );
  }
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactSensitive(child),
    ]),
  );
}

function assertEvent(value: unknown): RunEvent {
  if (!validateEvent(value)) {
    throw new Error(`Invalid run event: ${ajv.errorsText(validateEvent.errors)}`);
  }
  return structuredClone(value) as RunEvent;
}

export function validateRunResult(value: unknown): RunResult {
  if (!validateResult(value)) {
    throw new Error(`Invalid run result: ${ajv.errorsText(validateResult.errors)}`);
  }
  const result = structuredClone(value) as RunResult;
  if (result.validation.status === "not-run") {
    if (result.validation.checks.length !== 0 || result.durationsMs.validation !== null) {
      throw new Error("Validation not-run must have no checks or duration");
    }
  } else {
    if (result.validation.checks.length === 0 || result.durationsMs.validation === null) {
      throw new Error("Completed independent validation requires checks and a duration");
    }
    const expectedStatus = result.validation.checks.some((check) => check.status === "error")
      ? "error"
      : result.validation.checks.every((check) => check.status === "pass")
        ? "pass"
        : "fail";
    if (result.validation.status !== expectedStatus) {
      throw new Error(`Validation aggregate status must be ${expectedStatus}`);
    }
  }
  if (result.decision) validateRoutingDecision(result.decision, "run result");
  return result;
}

async function durableWrite(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export class AttemptArtifactStore {
  readonly directory: string;
  readonly eventsPath: string;
  readonly resultPath: string;
  readonly patchPath: string;
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly dedupe = new Map<string, number>();
  private decision: RoutingDecision | null = null;
  private finalized = false;
  private readonly startedAt: string;
  private readonly setupDurationMs: number;

  constructor(readonly options: StartAttemptOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.identity.runId)) {
      throw new Error("Run ID contains unsupported path characters");
    }
    this.directory = join(
      options.stateRoot,
      options.collection ?? "runs",
      options.identity.runId,
    );
    this.eventsPath = join(this.directory, "events.jsonl");
    this.resultPath = join(this.directory, "run.json");
    this.patchPath = join(this.directory, "patch.diff");
    this.startedAt = options.startedAt ?? new Date().toISOString();
    this.setupDurationMs = options.setupDurationMs ?? 0;
  }

  async initialize(): Promise<void> {
    await mkdir(
      join(this.options.stateRoot, this.options.collection ?? "runs"),
      { recursive: true, mode: 0o700 },
    );
    await mkdir(this.directory, { recursive: false, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const events = await open(this.eventsPath, "wx", 0o600);
    await events.close();
    await writeFile(this.patchPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  identity(decisionId: string | null = this.decision?.decisionId ?? null): AttemptIdentity {
    return { ...this.options.identity, decisionId };
  }

  appendEvent(
    kind: RunEventKind,
    payload: Record<string, unknown>,
    options: { dedupeKey?: string; decisionId?: string | null; timestamp?: string } = {},
  ): Promise<void> {
    if (this.finalized) return Promise.reject(new Error("Cannot append to a finalized attempt"));
    if (options.dedupeKey) {
      const existing = this.dedupe.get(options.dedupeKey);
      if (existing !== undefined) return this.queue;
    }
    const sequence = this.sequence + 1;
    this.sequence = sequence;
    if (options.dedupeKey) this.dedupe.set(options.dedupeKey, sequence);
    const event = assertEvent({
      schemaVersion: 1,
      sequence,
      timestamp: options.timestamp ?? new Date().toISOString(),
      identity: this.identity(options.decisionId),
      kind,
      payload: redactSensitive(payload),
    });
    this.queue = this.queue.then(async () => {
      const file = await open(this.eventsPath, "a", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    });
    return this.queue;
  }

  async recordDecision(
    decision: RoutingDecision,
    observation: "persisted" | "resumed-selection",
  ): Promise<void> {
    const validated = validateRoutingDecision(decision, "artifact decision");
    if (this.decision && this.decision.decisionId !== validated.decisionId) {
      throw new Error("An attempt cannot record more than one routing decision");
    }
    this.decision = validated;
    await this.appendEvent(
      "routing",
      { action: "decision-recorded", observation, decision: validated },
      { dedupeKey: `decision:${validated.decisionId}`, decisionId: validated.decisionId },
    );
  }

  async writePatch(patch: string): Promise<void> {
    if (this.finalized) throw new Error("Cannot write a patch after finalization");
    await durableWrite(this.patchPath, patch);
  }

  async finalizeAttempt(input: FinalizeAttemptInput): Promise<RunResult> {
    if (this.finalized) throw new Error("Attempt was already finalized");
    await this.queue;
    if (input.decision && this.decision?.decisionId !== input.decision.decisionId) {
      await this.recordDecision(input.decision, input.decisionObservation ?? "persisted");
      await this.queue;
    }
    const identity = this.identity(input.decision?.decisionId ?? null);
    const result = validateRunResult({
      schemaVersion: 1,
      identity,
      evidenceKind: this.options.evidenceKind,
      mode: this.options.mode,
      decision: input.decision,
      decisionObservation: input.decisionObservation,
      servedModel: input.servedModel,
      execution: {
        status: input.executionStatus,
        startedAt: this.startedAt,
        endedAt: input.endedAt === undefined ? new Date().toISOString() : input.endedAt,
        errorCategory: input.errorCategory ?? null,
      },
      validation: { status: "not-run", checks: [] },
      durationsMs: {
        setup: this.setupDurationMs,
        routing: input.routingDurationMs,
        agent: input.agentDurationMs,
        validation: null,
      },
      usage: input.usage,
      costs: input.costs,
      provenance: this.options.provenance,
      artifacts: {
        events: "events.jsonl",
        patch: "patch.diff",
      },
      missingReasons: [
        "independent validation has not run for this interactive session",
        ...(this.options.provenance.taskHash === null ? ["task hash is unavailable for interactive runs"] : []),
        ...(this.options.provenance.sourceHash === null ? ["source hash is unavailable for interactive runs"] : []),
        ...(this.options.provenance.validatorHash === null
          ? ["validator hash is unavailable for interactive runs"]
          : []),
        ...(input.missingReasons ?? []),
      ],
    });
    await this.appendEvent("finalization", {
      status: result.execution.status,
      validationStatus: result.validation.status,
    });
    await this.queue;
    await durableWrite(this.resultPath, `${JSON.stringify(result, null, 2)}\n`);
    this.finalized = true;
    return result;
  }

  async readAttempt(): Promise<AttemptRead> {
    return readAttempt(this.directory);
  }
}

export async function startAttempt(options: StartAttemptOptions): Promise<AttemptArtifactStore> {
  const store = new AttemptArtifactStore(options);
  await store.initialize();
  return store;
}

export async function readAttempt(directory: string): Promise<AttemptRead> {
  const eventsPath = join(directory, "events.jsonl");
  const source = await readFile(eventsPath, "utf8");
  const truncatedTail = source.length > 0 && !source.endsWith("\n");
  const lines = source.split("\n");
  if (truncatedTail) lines.pop();
  const events = lines
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return assertEvent(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid run event at line ${index + 1}; raw evidence retained at ${eventsPath}`, {
          cause: error,
        });
      }
    });
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      throw new Error(`Run event sequence is invalid at line ${index + 1}`);
    }
  });
  const resultPath = join(directory, "run.json");
  try {
    await stat(resultPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "incomplete", result: null, events, truncatedTail };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error) {
    throw new Error(`Finalized run result is corrupt; raw evidence retained at ${resultPath}`, {
      cause: error,
    });
  }
  return {
    status: "finalized",
    result: validateRunResult(parsed),
    events,
    truncatedTail,
  };
}

export async function attachValidationResult(
  directory: string,
  validation: IndependentValidationResult,
): Promise<RunResult> {
  const attempt = await readAttempt(directory);
  if (attempt.status !== "finalized" || attempt.result === null) {
    throw new Error("Cannot attach validation to an incomplete attempt");
  }
  if (attempt.result.validation.status !== "not-run") {
    throw new Error("Independent validation was already attached");
  }
  if (attempt.result.execution.status === "cancelled" && validation.status !== "not-run") {
    throw new Error("Cancelled execution must remain validation not-run");
  }
  const result = validateRunResult({
    ...attempt.result,
    validation: {
      status: validation.status,
      checks: validation.checks,
    },
    durationsMs: {
      ...attempt.result.durationsMs,
      validation: validation.durationMs,
    },
    missingReasons: attempt.result.missingReasons.filter(
      (reason) =>
        reason !== "independent validation has not run for this interactive session" &&
        reason !== "independent validation has not run through the Phase 07 evaluator" &&
        reason !== "independent validation is not available until Phase 07",
    ),
  });
  await durableWrite(join(directory, "run.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export type TrialOutcome = "pass" | "fail" | "unavailable" | "incomplete";

export function classifyTrialOutcome(result: RunResult): TrialOutcome {
  if (result.execution.status === "cancelled") return "incomplete";
  if (result.execution.status === "timeout" || result.execution.status === "budget-exhausted") {
    return "fail";
  }
  if (result.execution.status !== "completed") return "unavailable";
  if (result.validation.status === "not-run") return "incomplete";
  if (result.validation.status === "error") return "unavailable";
  return result.validation.status === "pass" ? "pass" : "fail";
}
