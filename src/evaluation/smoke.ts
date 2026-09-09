import { ALL_TASK_IDS, corpusDefinition, corpusHash, corpusTasks, type CorpusDefinition, type CorpusId, type TaskId } from "./corpus.js";
import { validateBenchmarkProtocol, verifyBenchmarkExecution, type BenchmarkProtocol } from "./benchmark.js";
import { atomicJson } from "./records.js";
import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { readAttempt, classifyTrialOutcome, type TrialOutcome } from "../artifacts/run-artifacts.js";
import { loadConfig, validateConfig, type LabConfig } from "../config/lab-config.js";
import { loadTaskDefinition, type EvaluationRoots } from "./task.js";

export const SMOKE_TASK_IDS = [
  "01-null-summary",
  "02-create-validation",
  "03-stable-filter",
] as const;
export const DEVELOPMENT_TASK_IDS = [
  ...SMOKE_TASK_IDS,
  "04-page-boundaries",
  "05-safe-result-types",
  "06-money-total",
] as const;
export const HELDOUT_TASK_IDS = [
  "07-tenant-authorization",
  "08-deduplicate-submit",
  "09-latest-search",
  "10-singleflight-cache",
  "11-retry-policy",
  "12-atomic-transfer",
  "13-import-diagnostics",
  "14-idempotent-events",
  "15-cancel-batch",
  "16-config-precedence",
  "17-subscription-lifecycle",
  "18-service-pagination",
] as const;
export const FULL_TASK_IDS = [...DEVELOPMENT_TASK_IDS, ...HELDOUT_TASK_IDS] as const;
export const EVALUATION_MODES = ["weak-only", "strong-only", "routed"] as const;
export const EVALUATION_SUITES = ["smoke", "dev", "heldout", "full"] as const;
export const MAX_ATTEMPTS_PER_TRIAL = 16;

export type SmokeTaskId = TaskId;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];
export type EvaluationSuite = (typeof EVALUATION_SUITES)[number];

interface ConfigCheckSummary {
  authProfile: string;
  roles: Record<"classifier" | "weak" | "strong", {
    provider: string;
    model: string;
    storedAuthAvailable: boolean;
    billing: "unknown" | "subscription" | "per-token";
  }>;
  policy: {
    weakThreshold: number;
    capabilityCardHash: string;
  };
  fingerprint: {
    value: string;
    configHash: string;
    capabilityCardHash: string;
    modelMetadataHash: string;
    providerConfigHash: string;
  };
}

export interface SmokeManifest {
  schemaVersion: 1 | 2;
  corpus?: CorpusDefinition;
  corpusHash?: string;
  sourceContentHash?: string;
  benchmark?: BenchmarkProtocol | null;
  manifestHash: string;
  experimentId: string;
  createdAt: string;
  evidenceKind: "mock" | "live";
  suite: EvaluationSuite;
  seed: number;
  repetitions: number;
  maxCostUsd: number | null;
  authProfile: string;
  threshold: number;
  fingerprints: ConfigCheckSummary["fingerprint"];
  roles: {
    classifier: LabConfig["models"]["classifier"];
    weak: LabConfig["models"]["weak"];
    strong: LabConfig["models"]["strong"];
  };
  limits: LabConfig["execution"];
  source: {
    revision: string | null;
    dirty: boolean | null;
  };
  images: {
    agent: string;
    evaluator: string;
    mock: string | null;
  };
  upstream: {
    piVersion: "0.85.0";
    switchyardRevision: "2dd67d76ad12961f92359153e03686773e3e8761";
    pnpmLockHash: string;
    cargoLockHash: string;
  };
  configuration: LabConfig;
  tasks: Array<{
    id: SmokeTaskId;
    taskHash: string;
    sourceHash: string;
    validatorHash: string;
    publicPrompt: string;
  }>;
  schedule: Array<{
    order: number;
    trialId: string;
    attemptId: string;
    attemptIds: string[];
    taskId: SmokeTaskId;
    repetition: number;
    mode: EvaluationMode;
    seed: number;
  }>;
}

export interface EvaluationPlan {
  schemaVersion: 1;
  corpus: CorpusId;
  maximumAgentSeconds: number;
  projectedAgentSeconds: number | null;
  suite: EvaluationSuite;
  available: boolean;
  taskCount: number;
  modes: readonly EvaluationMode[];
  repetitions: number;
  codingTrials: number;
  expectedClassifierCalls: number;
  seed: number;
  roles: SmokeManifest["roles"];
  limits: LabConfig["execution"];
  billing: {
    monetaryLimitSupported: boolean;
    reason: string | null;
  };
  scheduleHash: string | null;
}

export interface SmokeReport {
  schemaVersion: 1;
  experimentId: string;
  manifestHash: string;
  evidenceKind: "mock" | "live";
  suite: EvaluationSuite;
  threshold: number;
  roles: SmokeManifest["roles"];
  planned: number;
  evaluated: number;
  missing: number;
  modeResults: Record<EvaluationMode, {
    planned: number;
    pass: number;
    fail: number;
    unavailable: number;
    incomplete: number;
    observedSuccess: { numerator: number; denominator: number; value: number | null };
    operationalCompletion: { numerator: number; denominator: number; value: number };
  }>;
  routedDecisions: {
    weak: number;
    strong: number;
    fallback: number;
    total: number;
  };
  strongCodingShare: {
    numerator: number;
    denominator: number;
    value: number | null;
  };
  totalUsageTokens: number | null;
  totalEstimatedCostUsd: number | null;
  trials: Array<{
    trialId: string;
    attemptId: string;
    taskId: SmokeTaskId;
    mode: EvaluationMode;
    outcome: TrialOutcome;
    selectedTier: "weak" | "strong" | null;
    classifierFallback: boolean;
    validationStatus: "pass" | "fail" | "error" | "not-run";
    provider: string | null;
    model: string | null;
    totalTokens: number | null;
    estimatedCostUsd: number | null;
  }>;
  limitations: string[];
}

const hashPattern = "^[0-9a-f]{64}$";
const manifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "manifestHash", "experimentId", "createdAt", "evidenceKind", "suite",
    "seed", "repetitions", "maxCostUsd", "authProfile", "threshold", "fingerprints", "roles",
    "limits", "source", "images", "upstream", "configuration", "tasks", "schedule",
  ],
  properties: {
    schemaVersion: { const: 1 },
    manifestHash: { type: "string", pattern: hashPattern },
    experimentId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    createdAt: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T" },
    evidenceKind: { enum: ["mock", "live"] },
    suite: { enum: EVALUATION_SUITES },
    seed: { type: "integer", minimum: 0, maximum: 4294967295 },
    repetitions: { type: "integer", minimum: 1, maximum: 100 },
    maxCostUsd: { type: ["number", "null"], exclusiveMinimum: 0 },
    authProfile: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" },
    threshold: { type: "number", minimum: 0, maximum: 1 },
    fingerprints: {
      type: "object",
      additionalProperties: false,
      required: ["value", "configHash", "capabilityCardHash", "modelMetadataHash", "providerConfigHash"],
      properties: {
        value: { type: "string", pattern: hashPattern },
        configHash: { type: "string", pattern: hashPattern },
        capabilityCardHash: { type: "string", pattern: hashPattern },
        modelMetadataHash: { type: "string", pattern: hashPattern },
        providerConfigHash: { type: "string", pattern: hashPattern },
      },
    },
    roles: {
      type: "object",
      additionalProperties: false,
      required: ["classifier", "weak", "strong"],
      properties: Object.fromEntries(
        ["classifier", "weak", "strong"].map((role) => [role, {
          type: "object",
          additionalProperties: true,
          required: ["provider", "model"],
          properties: {
            provider: { type: "string", minLength: 1 },
            model: { type: "string", minLength: 1 },
            billing: { enum: ["unknown", "subscription", "per-token"] },
          },
        }]),
      ),
    },
    limits: { type: "object" },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["revision", "dirty"],
      properties: {
        revision: { type: ["string", "null"], pattern: "^[0-9a-f]{40}$" },
        dirty: { type: ["boolean", "null"] },
      },
    },
    images: {
      type: "object",
      additionalProperties: false,
      required: ["agent", "evaluator", "mock"],
      properties: {
        agent: { type: "string", minLength: 1 },
        evaluator: { type: "string", minLength: 1 },
        mock: { type: ["string", "null"], minLength: 1 },
      },
    },
    upstream: {
      type: "object",
      additionalProperties: false,
      required: ["piVersion", "switchyardRevision", "pnpmLockHash", "cargoLockHash"],
      properties: {
        piVersion: { const: "0.85.0" },
        switchyardRevision: {
          const: "2dd67d76ad12961f92359153e03686773e3e8761",
        },
        pnpmLockHash: { type: "string", pattern: hashPattern },
        cargoLockHash: { type: "string", pattern: hashPattern },
      },
    },
    configuration: { type: "object" },
    tasks: {
      type: "array",
      minItems: 3,
      maxItems: 42,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "taskHash", "sourceHash", "validatorHash", "publicPrompt"],
        properties: {
          id: { enum: ALL_TASK_IDS },
          taskHash: { type: "string", pattern: hashPattern },
          sourceHash: { type: "string", pattern: hashPattern },
          validatorHash: { type: "string", pattern: hashPattern },
          publicPrompt: { type: "string", minLength: 1 },
        },
      },
    },
    schedule: {
      type: "array",
      minItems: 9,
      maxItems: 12600,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "order", "trialId", "attemptId", "attemptIds", "taskId", "repetition", "mode", "seed",
        ],
        properties: {
          order: { type: "integer", minimum: 0 },
          trialId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
          attemptId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
          attemptIds: {
            type: "array",
            minItems: MAX_ATTEMPTS_PER_TRIAL,
            maxItems: MAX_ATTEMPTS_PER_TRIAL,
            uniqueItems: true,
            items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
          },
          taskId: { enum: ALL_TASK_IDS },
          repetition: { type: "integer", minimum: 0, maximum: 99 },
          mode: { enum: EVALUATION_MODES },
          seed: { type: "integer", minimum: 0, maximum: 4294967295 },
        },
      },
    },
  },
} as const;

const ajv = new Ajv2020Module.default({ allErrors: true, strict: false, formats: {} });
const validateManifestV1 = ajv.compile(manifestSchema);
const validateManifestV2 = ajv.compile({ ...manifestSchema, required: [...manifestSchema.required, "corpus", "corpusHash", "sourceContentHash", "benchmark"], properties: { ...manifestSchema.properties, schemaVersion: { const: 2 }, corpus: { type: "object" }, corpusHash: { type: "string", pattern: hashPattern }, sourceContentHash: { type: "string", pattern: hashPattern }, benchmark: { type: ["object", "null"] } } });
const countSchema = { type: "integer", minimum: 0 } as const;
const nullableNumberSchema = { type: ["number", "null"] } as const;
export const SMOKE_REPORT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "experimentId", "manifestHash", "evidenceKind", "suite", "threshold", "roles",
    "planned", "evaluated", "missing", "modeResults", "routedDecisions",
    "strongCodingShare", "totalUsageTokens", "totalEstimatedCostUsd", "trials", "limitations",
  ],
  properties: {
    schemaVersion: { const: 1 },
    experimentId: { type: "string", minLength: 1 },
    manifestHash: { type: "string", pattern: hashPattern },
    evidenceKind: { enum: ["mock", "live"] },
    suite: { enum: EVALUATION_SUITES },
    threshold: { type: "number", minimum: 0, maximum: 1 },
    roles: manifestSchema.properties.roles,
    planned: countSchema,
    evaluated: countSchema,
    missing: countSchema,
    modeResults: {
      type: "object",
      additionalProperties: false,
      required: EVALUATION_MODES,
      properties: Object.fromEntries(EVALUATION_MODES.map((mode) => [mode, {
        type: "object",
        additionalProperties: false,
        required: [
          "planned", "pass", "fail", "unavailable", "incomplete",
          "observedSuccess", "operationalCompletion",
        ],
        properties: {
          planned: countSchema,
          pass: countSchema,
          fail: countSchema,
          unavailable: countSchema,
          incomplete: countSchema,
          observedSuccess: {
            type: "object",
            additionalProperties: false,
            required: ["numerator", "denominator", "value"],
            properties: {
              numerator: countSchema,
              denominator: countSchema,
              value: nullableNumberSchema,
            },
          },
          operationalCompletion: {
            type: "object",
            additionalProperties: false,
            required: ["numerator", "denominator", "value"],
            properties: {
              numerator: countSchema,
              denominator: countSchema,
              value: { type: "number" },
            },
          },
        },
      }])),
    },
    routedDecisions: {
      type: "object",
      additionalProperties: false,
      required: ["weak", "strong", "fallback", "total"],
      properties: {
        weak: countSchema,
        strong: countSchema,
        fallback: countSchema,
        total: countSchema,
      },
    },
    strongCodingShare: {
      type: "object",
      additionalProperties: false,
      required: ["numerator", "denominator", "value"],
      properties: {
        numerator: countSchema,
        denominator: countSchema,
        value: nullableNumberSchema,
      },
    },
    totalUsageTokens: { type: ["integer", "null"], minimum: 0 },
    totalEstimatedCostUsd: { type: ["number", "null"], minimum: 0 },
    trials: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "trialId", "taskId", "mode", "outcome", "selectedTier", "classifierFallback",
          "attemptId", "validationStatus", "provider", "model", "totalTokens", "estimatedCostUsd",
        ],
        properties: {
          trialId: { type: "string", minLength: 1 },
          attemptId: { type: "string", minLength: 1 },
          taskId: { enum: ALL_TASK_IDS },
          mode: { enum: EVALUATION_MODES },
          outcome: { enum: ["pass", "fail", "unavailable", "incomplete"] },
          selectedTier: { enum: ["weak", "strong", null] },
          classifierFallback: { type: "boolean" },
          validationStatus: { enum: ["pass", "fail", "error", "not-run"] },
          provider: { type: ["string", "null"] },
          model: { type: ["string", "null"] },
          totalTokens: { type: ["integer", "null"], minimum: 0 },
          estimatedCostUsd: { type: ["number", "null"], minimum: 0 },
        },
      },
    },
    limitations: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;
const validateReport = ajv.compile(SMOKE_REPORT_SCHEMA);

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contentHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  return shuffled;
}

export function smokeSchedule(seed = 20260905, repetitions = 1): SmokeManifest["schedule"] {
  return evaluationSchedule(SMOKE_TASK_IDS, seed, repetitions);
}

export function taskIdsForSuite(suite: EvaluationSuite, corpus: CorpusId = "core"): readonly SmokeTaskId[] {
  return corpusTasks(corpus, suite);
}

function evaluationSchedule<T extends string>(
  taskIds: readonly T[],
  seed: number,
  repetitions: number,
) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new Error("Repetitions must be an integer from 1 to 100");
  }
  const random = mulberry32(seed);
  const triplets = [...taskIds]
    .sort()
    .flatMap((taskId) =>
      Array.from({ length: repetitions }, (_, repetition) => ({ taskId, repetition })),
    );
  let order = 0;
  return shuffle(triplets, random).flatMap(({ taskId, repetition }) =>
    shuffle(EVALUATION_MODES, random).map((mode) => {
      const trialId = `${taskId}-r${repetition + 1}-${mode}`;
      const attemptIds = Array.from(
        { length: MAX_ATTEMPTS_PER_TRIAL },
        (_, index) => `${trialId}-a${index + 1}`,
      );
      return {
        order: order++,
        trialId,
        attemptId: attemptIds[0]!,
        attemptIds,
        taskId,
        repetition,
        mode,
        seed,
      };
    }),
  );
}

function monetaryLimitReason(config: LabConfig): string | null {
  for (const role of ["classifier", "weak", "strong"] as const) {
    const model = config.models[role];
    if (model.billing !== "per-token" || !model.pricing) {
      return `${role} uses ${model.billing} billing`;
    }
    if (
      model.pricing.cacheReadPerMillion === undefined ||
      model.pricing.cacheWritePerMillion === undefined
    ) {
      return `${role} lacks cache pricing needed for a conservative bound`;
    }
  }
  return null;
}

export function createEvaluationPlan(
  config: LabConfig,
  options: { suite: EvaluationSuite; repetitions: number; seed: number; corpus?: CorpusId; meanAgentMs?: number },
): EvaluationPlan {
  const suiteTasks = taskIdsForSuite(options.suite, options.corpus);
  const available = suiteTasks.length > 0;
  const schedule = available
    ? evaluationSchedule(suiteTasks, options.seed, options.repetitions)
    : [];
  const billingReason = monetaryLimitReason(config);
  return {
    schemaVersion: 1,
    suite: options.suite,
    corpus: options.corpus ?? "core",
    maximumAgentSeconds: schedule.length * config.execution.timeoutSeconds,
    projectedAgentSeconds: options.meanAgentMs === undefined ? null : schedule.length * options.meanAgentMs / 1000,
    available,
    taskCount: available ? suiteTasks.length : 0,
    modes: EVALUATION_MODES,
    repetitions: options.repetitions,
    codingTrials: schedule.length,
    expectedClassifierCalls: available ? suiteTasks.length * options.repetitions : 0,
    seed: options.seed,
    roles: structuredClone(config.models),
    limits: structuredClone(config.execution),
    billing: {
      monetaryLimitSupported: billingReason === null,
      reason: billingReason,
    },
    scheduleHash: available ? hash(schedule) : null,
  };
}

export function conservativeTrialCostBound(
  config: LabConfig,
  mode: EvaluationMode,
): number {
  const reason = monetaryLimitReason(config);
  if (reason) throw new Error(`Monetary limit is unavailable: ${reason}`);
  const requestBound = (role: "classifier" | "weak" | "strong") => {
    const pricing = config.models[role].pricing!;
    const inputRate = Math.max(
      pricing.inputPerMillion,
      pricing.cacheReadPerMillion!,
      pricing.cacheWritePerMillion!,
    );
    return (
      config.execution.contextTokenCap * inputRate +
      config.execution.maxOutputTokens * pricing.outputPerMillion
    ) / 1_000_000;
  };
  const coding =
    mode === "weak-only"
      ? requestBound("weak")
      : mode === "strong-only"
        ? requestBound("strong")
        : Math.max(requestBound("weak"), requestBound("strong"));
  return coding * config.execution.maxAgentTurns +
    (mode === "routed" ? requestBound("classifier") : 0);
}

function configCheckSummary(value: unknown): ConfigCheckSummary {
  if (typeof value !== "object" || value === null) throw new Error("Config check result is invalid");
  const summary = value as Partial<ConfigCheckSummary> & { status?: unknown };
  if (
    summary.status !== "ok" ||
    typeof summary.authProfile !== "string" ||
    typeof summary.roles !== "object" ||
    summary.roles === null ||
    typeof summary.policy !== "object" ||
    summary.policy === null ||
    typeof summary.fingerprint !== "object" ||
    summary.fingerprint === null
  ) {
    throw new Error("Config check result is incomplete");
  }
  for (const role of ["classifier", "weak", "strong"] as const) {
    const entry = summary.roles[role];
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.provider !== "string" ||
      typeof entry.model !== "string" ||
      typeof entry.storedAuthAvailable !== "boolean"
    ) {
      throw new Error(`Config check result is missing role ${role}`);
    }
  }
  return summary as ConfigCheckSummary;
}

export async function createSmokeManifest(options: {
  roots: EvaluationRoots;
  resultsRoot: string;
  configPath: string;
  configCheckPath: string;
  experimentId: string;
  evidenceKind: "mock" | "live";
  suite?: EvaluationSuite;
  corpus?: CorpusId;
  sourceContentHash?: string;
  benchmark?: BenchmarkProtocol;
  seed?: number;
  repetitions?: number;
  maxCostUsd?: number | null;
  revision: string | null;
  dirty: boolean | null;
  images: SmokeManifest["images"];
  lockPaths?: {
    pnpm: string;
    cargo: string;
  };
}): Promise<{ directory: string; manifest: SmokeManifest }> {
  const config = await loadConfig(options.configPath);
  const checked = configCheckSummary(JSON.parse(await readFile(options.configCheckPath, "utf8")));
  for (const role of ["classifier", "weak", "strong"] as const) {
    const expected = config.models[role];
    const actual = checked.roles[role];
    if (expected.provider !== actual.provider || expected.model !== actual.model) {
      throw new Error(`Resolved ${role} model does not match configuration`);
    }
    if (options.evidenceKind === "live" && !actual.storedAuthAvailable) {
      throw new Error(`Live smoke evaluation requires Pi authentication for ${actual.provider}`);
    }
  }
  const suite = options.suite ?? "smoke";
  const suiteTaskIds = taskIdsForSuite(suite, options.corpus);
  const tasks = await Promise.all(
    suiteTaskIds.map(async (id) => {
      const loaded = await loadTaskDefinition(id, options.roots);
      return {
        id,
        taskHash: loaded.taskHash,
        sourceHash: loaded.definition.fixture.hash,
        validatorHash: loaded.definition.validatorHash,
        publicPrompt: loaded.definition.publicPrompt,
      };
    }),
  );
  const seed = options.seed ?? 20260905;
  const repetitions = options.repetitions ?? 1;
  const maxCostUsd = options.maxCostUsd ?? null;
  if (maxCostUsd !== null) {
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      throw new Error("Maximum cost must be a positive finite USD amount");
    }
    const reason = monetaryLimitReason(config);
    if (reason) throw new Error(`Monetary limit is unavailable: ${reason}`);
    const firstBound = Math.max(
      ...EVALUATION_MODES.map((mode) => conservativeTrialCostBound(config, mode)),
    );
    if (firstBound > maxCostUsd) {
      throw new Error(
        `Insufficient monetary budget before first trial: required ${firstBound}, available ${maxCostUsd}`,
      );
    }
  }
  const version2 = options.sourceContentHash !== undefined;
  if (options.corpus && options.corpus !== "core" && !version2) throw new Error("Extended corpora require version 2 source provenance");
  if (options.benchmark) await verifyBenchmarkExecution(options.benchmark, {
    corpus: options.corpus ?? "core", suite, repetitions, maxCostUsd, seed, evidenceKind: options.evidenceKind,
    sourceContentHash: options.sourceContentHash ?? "", images: options.images, configuration: config, roots: options.roots,
  });
  const corpus = corpusDefinition(options.corpus ?? "core");
  const withoutHash = {
    schemaVersion: version2 ? 2 as const : 1 as const,
    ...(version2 ? { corpus, corpusHash: corpusHash(corpus), sourceContentHash: options.sourceContentHash!, benchmark: options.benchmark ?? null } : {}),
    experimentId: options.experimentId,
    createdAt: new Date().toISOString(),
    evidenceKind: options.evidenceKind,
    suite,
    seed,
    repetitions,
    maxCostUsd,
    authProfile: checked.authProfile,
    threshold: config.routing.weakThreshold,
    fingerprints: structuredClone(checked.fingerprint),
    roles: structuredClone(config.models),
    limits: structuredClone(config.execution),
    source: { revision: options.revision, dirty: options.dirty },
    images: structuredClone(options.images),
    upstream: {
      piVersion: "0.85.0" as const,
      switchyardRevision: "2dd67d76ad12961f92359153e03686773e3e8761" as const,
      pnpmLockHash: contentHash(
        await readFile(options.lockPaths?.pnpm ?? join(process.cwd(), "pnpm-lock.yaml")),
      ),
      cargoLockHash: contentHash(
        await readFile(
          options.lockPaths?.cargo ??
            join(process.cwd(), "rust", "switchyard-bridge", "Cargo.lock"),
        ),
      ),
    },
    configuration: structuredClone(config),
    tasks,
    schedule: evaluationSchedule(suiteTaskIds, seed, repetitions),
  };
  const manifest = validateSmokeManifest({ ...withoutHash, manifestHash: hash(withoutHash) });
  const directory = join(options.resultsRoot, options.experimentId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await durableJson(join(directory, "manifest.json"), manifest);
  if (manifest.benchmark) await atomicJson(join(directory, "protocol.json"), manifest.benchmark);
  return { directory, manifest };
}

export function validateSmokeManifest(value: unknown): SmokeManifest {
  const validateManifest = (value as { schemaVersion?: number })?.schemaVersion === 2 ? validateManifestV2 : validateManifestV1;
  if (!validateManifest(value)) {
    throw new Error(`Invalid smoke manifest: ${ajv.errorsText(validateManifest.errors)}`);
  }
  const manifest = structuredClone(value) as SmokeManifest;
  if (manifest.schemaVersion === 2) {
    if (JSON.stringify(manifest.corpus) !== JSON.stringify(corpusDefinition(manifest.corpus!.id)) || manifest.corpusHash !== corpusHash(manifest.corpus!)) throw new Error("Manifest corpus registry changed");
    if (manifest.benchmark) {
      const protocol = validateBenchmarkProtocol(manifest.benchmark);
      if (manifest.suite !== protocol.suite || manifest.corpus!.id !== protocol.corpus.id || manifest.seed !== protocol.seed || manifest.repetitions !== protocol.repetitions || manifest.maxCostUsd !== protocol.maxCostUsd || manifest.sourceContentHash !== protocol.sourceContentHash || manifest.evidenceKind !== protocol.evidenceKind || JSON.stringify(manifest.configuration) !== JSON.stringify(protocol.configuration) || manifest.images.agent !== protocol.images.agent || manifest.images.evaluator !== protocol.images.evaluator || JSON.stringify(manifest.tasks.map(({ id, taskHash, sourceHash, validatorHash }) => ({ id, taskHash, sourceHash, validatorHash }))) !== JSON.stringify(protocol.tasks)) throw new Error("Manifest differs from its frozen benchmark");
    }
  }
  const expectedTaskIds = taskIdsForSuite(manifest.suite, manifest.corpus?.id);
  if (
    manifest.tasks.length !== expectedTaskIds.length ||
    manifest.tasks.some((task, index) => task.id !== expectedTaskIds[index])
  ) {
    throw new Error(`Manifest tasks do not match suite ${manifest.suite}`);
  }
  manifest.configuration = validateConfig(manifest.configuration);
  const { manifestHash, ...withoutHash } = manifest;
  if (manifestHash !== hash(withoutHash)) throw new Error("Smoke manifest hash mismatch");
  const allAttemptIds = manifest.schedule.flatMap(({ attemptIds }) => attemptIds);
  if (
    new Set(manifest.tasks.map(({ id }) => id)).size !== expectedTaskIds.length ||
    new Set(manifest.schedule.map(({ trialId }) => trialId)).size !== manifest.schedule.length ||
    manifest.schedule.length !==
      expectedTaskIds.length * manifest.repetitions * EVALUATION_MODES.length ||
    manifest.schedule.some(
      (trial, index) =>
        trial.order !== index ||
        trial.attemptId !== trial.attemptIds[0] ||
        new Set(trial.attemptIds).size !== MAX_ATTEMPTS_PER_TRIAL,
    ) ||
    new Set(allAttemptIds).size !== allAttemptIds.length ||
    JSON.stringify(manifest.schedule) !==
      JSON.stringify(evaluationSchedule(expectedTaskIds, manifest.seed, manifest.repetitions))
  ) {
    throw new Error("Smoke manifest contains duplicate or missing task/trial identities");
  }
  return manifest;
}

export async function readSmokeManifest(path: string): Promise<SmokeManifest> {
  return validateSmokeManifest(JSON.parse(await readFile(path, "utf8")));
}

export function jobAt(manifest: SmokeManifest, index: number, attemptIndex = 0) {
  const trial = manifest.schedule[index];
  if (!trial) throw new Error(`Smoke job index ${index} is outside the manifest`);
  const attemptId = trial.attemptIds[attemptIndex];
  if (!attemptId) {
    throw new Error(`Attempt index ${attemptIndex} is outside trial ${trial.trialId}`);
  }
  const task = manifest.tasks.find(({ id }) => id === trial.taskId);
  if (!task) throw new Error(`Smoke task ${trial.taskId} is absent from the manifest`);
  return {
    ...trial,
    ...task,
    attemptId,
    attemptIndex,
    previousAttemptId: attemptIndex === 0 ? null : trial.attemptIds[attemptIndex - 1]!,
  };
}

export type EvaluationNextAction =
  | {
      action: "run";
      job: ReturnType<typeof jobAt>;
    }
  | {
      action: "validate";
      job: ReturnType<typeof jobAt>;
    }
  | {
      action: "done";
    };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function experimentSpend(
  directory: string,
  manifest: SmokeManifest,
): Promise<{ known: boolean; total: number }> {
  let total = 0;
  for (const trial of manifest.schedule) {
    for (const attemptId of trial.attemptIds) {
      const attemptDirectory = join(directory, "attempts", attemptId);
      if (!(await exists(attemptDirectory))) break;
      const attempt = await readAttempt(attemptDirectory);
      if (attempt.status !== "finalized" || attempt.result === null) {
        return { known: false, total };
      }
      const cost = attempt.result.costs.totalEstimatedCostUsd;
      if (cost === null && attempt.result.usage.total.observedCalls > 0) {
        return { known: false, total };
      }
      total += cost ?? 0;
    }
  }
  return { known: true, total };
}

export async function nextEvaluationAction(
  experimentDirectory: string,
): Promise<EvaluationNextAction> {
  const manifest = await readSmokeManifest(join(experimentDirectory, "manifest.json"));
  const spend = await experimentSpend(experimentDirectory, manifest);
  if (manifest.maxCostUsd !== null && !spend.known) {
    throw new Error("Monetary dispatch stopped because billed usage became unknown");
  }
  for (let trialIndex = 0; trialIndex < manifest.schedule.length; trialIndex++) {
    const trial = manifest.schedule[trialIndex]!;
    let terminal = false;
    for (let attemptIndex = 0; attemptIndex < trial.attemptIds.length; attemptIndex++) {
      const job = jobAt(manifest, trialIndex, attemptIndex);
      const attemptDirectory = join(experimentDirectory, "attempts", job.attemptId);
      if (!(await exists(attemptDirectory))) {
        if (manifest.maxCostUsd !== null) {
          const bound = conservativeTrialCostBound(manifest.configuration, trial.mode);
          if (spend.total + bound > manifest.maxCostUsd) {
            throw new Error(
              `Monetary budget exhausted before ${trial.trialId}: ` +
                `spent ${spend.total}, reserve ${bound}, cap ${manifest.maxCostUsd}`,
            );
          }
        }
        return { action: "run", job };
      }
      const attempt = await readAttempt(attemptDirectory);
      if (attempt.status !== "finalized" || attempt.result === null) continue;
      if (
        attempt.result.identity.attemptId !== job.attemptId ||
        attempt.result.identity.experimentId !== manifest.experimentId ||
        attempt.result.identity.taskId !== trial.taskId ||
        attempt.result.identity.repetition !== trial.repetition ||
        attempt.result.mode !== trial.mode
      ) {
        throw new Error(`Attempt identity mismatch for ${job.attemptId}`);
      }
      const outcome = classifyTrialOutcome(attempt.result);
      if (outcome === "pass" || outcome === "fail") {
        terminal = true;
        break;
      }
      if (
        attempt.result.execution.status === "completed" &&
        attempt.result.validation.status === "not-run" &&
        (await exists(join(attemptDirectory, "submission.json")))
      ) {
        return { action: "validate", job };
      }
    }
    if (!terminal) {
      throw new Error(`Recovery attempt limit exhausted for ${trial.trialId}`);
    }
  }
  return { action: "done" };
}

export async function verifyResumeCompatibility(options: {
  experimentDirectory: string;
  sourceContentHash?: string;
  roots: EvaluationRoots;
  configPath: string;
  configCheckPath: string;
  evidenceKind: "mock" | "live";
  images: SmokeManifest["images"];
  lockPaths: {
    pnpm: string;
    cargo: string;
  };
}): Promise<SmokeManifest> {
  const manifest = await readSmokeManifest(join(options.experimentDirectory, "manifest.json"));
  if (manifest.schemaVersion === 2 && manifest.sourceContentHash !== options.sourceContentHash) throw new Error("Resume source content changed");
  if (manifest.benchmark && JSON.stringify(JSON.parse(await readFile(join(options.experimentDirectory, "protocol.json"), "utf8"))) !== JSON.stringify(manifest.benchmark)) throw new Error("Resume frozen protocol copy changed");
  if (manifest.evidenceKind !== options.evidenceKind) {
    throw new Error(
      manifest.evidenceKind === "live"
        ? "Live experiment resume requires --live"
        : "Mock experiment cannot be resumed as live",
    );
  }
  const config = await loadConfig(options.configPath);
  const checked = configCheckSummary(JSON.parse(await readFile(options.configCheckPath, "utf8")));
  if (
    JSON.stringify(config) !== JSON.stringify(manifest.configuration) ||
    JSON.stringify(checked.fingerprint) !== JSON.stringify(manifest.fingerprints) ||
    checked.authProfile !== manifest.authProfile ||
    JSON.stringify(options.images) !== JSON.stringify(manifest.images) ||
    contentHash(await readFile(options.lockPaths.pnpm)) !== manifest.upstream.pnpmLockHash ||
    contentHash(await readFile(options.lockPaths.cargo)) !== manifest.upstream.cargoLockHash
  ) {
    throw new Error("Resume configuration, profile, model fingerprint, or image identity changed");
  }
  for (const task of manifest.tasks) {
    const loaded = await loadTaskDefinition(task.id, options.roots);
    if (
      loaded.taskHash !== task.taskHash ||
      loaded.definition.fixture.hash !== task.sourceHash ||
      loaded.definition.validatorHash !== task.validatorHash
    ) {
      throw new Error(`Resume task or validator hash changed for ${task.id}`);
    }
  }
  return manifest;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function markdown(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|");
}

function reportMarkdown(report: SmokeReport, manifest: SmokeManifest): string {
  const lines = [
    `# ${markdown(report.suite)} experiment ${markdown(report.experimentId)}`,
    "",
    `Evidence: **${report.evidenceKind}** (integration evidence, not model-capability evidence)`,
    "",
    `Threshold: ${report.threshold}; planned ${report.planned}; evaluated ${report.evaluated}; missing ${report.missing}.`,
    "",
    "| Mode | PASS | FAIL | Unavailable | Incomplete | Observed success |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const mode of EVALUATION_MODES) {
    const result = report.modeResults[mode];
    lines.push(
      `| ${mode} | ${result.pass} | ${result.fail} | ${result.unavailable} | ${result.incomplete} | ` +
        `${result.observedSuccess.numerator}/${result.observedSuccess.denominator} |`,
    );
  }
  lines.push(
    "",
    `Routed decisions: weak ${report.routedDecisions.weak}, strong ${report.routedDecisions.strong}, ` +
      `fallback ${report.routedDecisions.fallback}.`,
    "",
    `Strong coding share: ${report.strongCodingShare.numerator}/${report.strongCodingShare.denominator}.`,
    "",
    "| Task | Attempt | Mode | Outcome | Tier | Fallback | Validation | Provider/model | Tokens | Estimated USD |",
    "|---|---|---|---|---|---|---|---|---:|---:|",
  );
  for (const trial of report.trials) {
    lines.push(
      `| ${trial.taskId} | ${trial.attemptId} | ${trial.mode} | ${trial.outcome} | ${trial.selectedTier ?? "n/a"} | ` +
        `${trial.classifierFallback ? "yes" : "no"} | ${trial.validationStatus} | ` +
        `${markdown(trial.provider && trial.model ? `${trial.provider}/${trial.model}` : "n/a")} | ` +
        `${trial.totalTokens ?? "unknown"} | ${trial.estimatedCostUsd ?? "unknown"} |`,
    );
  }
  lines.push(
    "",
    "## Roles",
    "",
    ...(["classifier", "weak", "strong"] as const).map((role) => {
      const model = manifest.roles[role];
      return `- ${role}: ${markdown(model.provider)}/${markdown(model.model)} (${model.billing ?? "unknown"})`;
    }),
    "",
    "## Limitations",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
  );
  return lines.join("\n");
}

export async function generateSmokeReport(experimentDirectory: string): Promise<SmokeReport> {
  const manifest = await readSmokeManifest(join(experimentDirectory, "manifest.json"));
  const trials: SmokeReport["trials"] = [];
  const physicalUsage: Array<number | null> = [];
  const physicalCosts: Array<number | null> = [];
  let physicalAttemptIncomplete = false;
  for (const scheduled of manifest.schedule) {
    let selectedAttempt:
      | Awaited<ReturnType<typeof readAttempt>> & { selectedAttemptId: string }
      | null = null;
    try {
      for (const attemptId of scheduled.attemptIds) {
        try {
          await access(join(experimentDirectory, "attempts", attemptId));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
        const attempt = await readAttempt(join(experimentDirectory, "attempts", attemptId));
        if (attempt.status === "finalized" && attempt.result !== null) {
          physicalUsage.push(attempt.result.usage.total.totalTokens);
          physicalCosts.push(attempt.result.costs.totalEstimatedCostUsd);
        } else {
          physicalAttemptIncomplete = true;
        }
        selectedAttempt = { ...attempt, selectedAttemptId: attemptId };
        if (
          attempt.status === "finalized" &&
          attempt.result !== null &&
          ["pass", "fail"].includes(classifyTrialOutcome(attempt.result))
        ) {
          break;
        }
      }
      if (
        selectedAttempt === null ||
        selectedAttempt.status !== "finalized" ||
        selectedAttempt.result === null
      ) {
        continue;
      }
      const result = selectedAttempt.result;
      if (
        result.identity.experimentId !== manifest.experimentId ||
        result.identity.taskId !== scheduled.taskId ||
        result.identity.attemptId !== selectedAttempt.selectedAttemptId ||
        !scheduled.attemptIds.includes(result.identity.attemptId) ||
        result.mode !== scheduled.mode
      ) {
        throw new Error(`Attempt identity mismatch for ${selectedAttempt.selectedAttemptId}`);
      }
      if (
        result.provenance.configHash !== manifest.fingerprints.configHash ||
        result.provenance.capabilityCardHash !== manifest.fingerprints.capabilityCardHash ||
        result.provenance.modelMetadataHash !== manifest.fingerprints.modelMetadataHash ||
        result.provenance.providerConfigHash !== manifest.fingerprints.providerConfigHash ||
        result.provenance.authProfile !== manifest.authProfile
      ) {
        throw new Error(
          `Attempt configuration fingerprint mismatch for ${selectedAttempt.selectedAttemptId}`,
        );
      }
      const task = manifest.tasks.find(({ id }) => id === scheduled.taskId)!;
      if (
        result.provenance.taskHash !== task.taskHash ||
        result.provenance.sourceHash !== task.sourceHash ||
        result.provenance.validatorHash !== task.validatorHash
      ) {
        throw new Error(`Attempt provenance mismatch for ${selectedAttempt.selectedAttemptId}`);
      }
      const selectedTier =
        result.decision?.selectedTier ??
        (scheduled.mode === "strong-only" ? "strong" : scheduled.mode === "weak-only" ? "weak" : null);
      trials.push({
        trialId: scheduled.trialId,
        attemptId: selectedAttempt.selectedAttemptId,
        taskId: scheduled.taskId,
        mode: scheduled.mode,
        outcome: classifyTrialOutcome(result),
        selectedTier,
        classifierFallback: result.decision?.source === "classifier-fallback",
        validationStatus: result.validation.status,
        provider: result.servedModel?.provider ?? null,
        model: result.servedModel?.model ?? null,
        totalTokens: result.usage.total.totalTokens,
        estimatedCostUsd: result.costs.totalEstimatedCostUsd,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const modeResults = Object.fromEntries(
    EVALUATION_MODES.map((mode) => {
      const selected = trials.filter((trial) => trial.mode === mode);
      const counts = {
        pass: selected.filter(({ outcome }) => outcome === "pass").length,
        fail: selected.filter(({ outcome }) => outcome === "fail").length,
        unavailable: selected.filter(({ outcome }) => outcome === "unavailable").length,
        incomplete: selected.filter(({ outcome }) => outcome === "incomplete").length,
      };
      const evaluated = counts.pass + counts.fail;
      const completed = evaluated;
      const planned = manifest.tasks.length * manifest.repetitions;
      return [mode, {
        planned,
        ...counts,
        observedSuccess: {
          numerator: counts.pass,
          denominator: evaluated,
          value: ratio(counts.pass, evaluated),
        },
        operationalCompletion: {
          numerator: completed,
          denominator: planned,
          value: completed / planned,
        },
      }];
    }),
  ) as SmokeReport["modeResults"];
  const routed = trials.filter(({ mode }) => mode === "routed");
  const selected = trials.filter(({ selectedTier }) => selectedTier !== null);
  const knownTokens =
    !physicalAttemptIncomplete && physicalUsage.every((tokens) => tokens !== null);
  const knownCosts =
    !physicalAttemptIncomplete && physicalCosts.every((cost) => cost !== null);
  const evaluated = trials.filter(({ outcome }) => outcome === "pass" || outcome === "fail").length;
  const report = validateSmokeReport({
    schemaVersion: 1,
    experimentId: manifest.experimentId,
    manifestHash: manifest.manifestHash,
    evidenceKind: manifest.evidenceKind,
    suite: manifest.suite,
    threshold: manifest.threshold,
    roles: structuredClone(manifest.roles),
    planned: manifest.schedule.length,
    evaluated,
    missing: manifest.schedule.length - evaluated,
    modeResults,
    routedDecisions: {
      weak: routed.filter(({ selectedTier }) => selectedTier === "weak").length,
      strong: routed.filter(({ selectedTier }) => selectedTier === "strong").length,
      fallback: routed.filter(({ classifierFallback }) => classifierFallback).length,
      total: routed.filter(({ selectedTier }) => selectedTier !== null).length,
    },
    strongCodingShare: {
      numerator: selected.filter(({ selectedTier }) => selectedTier === "strong").length,
      denominator: selected.length,
      value: ratio(
        selected.filter(({ selectedTier }) => selectedTier === "strong").length,
        selected.length,
      ),
    },
    totalUsageTokens: knownTokens
      ? physicalUsage.reduce((total, tokens) => total + (tokens ?? 0), 0)
      : null,
    totalEstimatedCostUsd: knownCosts
      ? physicalCosts.reduce((total, cost) => total + (cost ?? 0), 0)
      : null,
    trials,
    limitations: [
      `This smoke suite has ${manifest.repetitions} repetition(s) per mode and is not statistically conclusive.`,
      "Mock evidence validates integration only; it does not measure live model capability.",
      "Aggregate usage and cost include every finalized physical attempt, including superseded recovery attempts.",
      "The one-repetition smoke matrix is descriptive; use repeated development experiments for uncertainty and threshold analysis.",
      "Unknown or subscription billing remains null and is not interpreted as zero spend.",
    ],
  });
  await durableJson(join(experimentDirectory, "experiment.json"), report);
  const markdownPath = join(experimentDirectory, "experiment.md");
  const temporary = `${markdownPath}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(reportMarkdown(report, manifest), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temporary, markdownPath);
  return report;
}

export function validateSmokeReport(value: unknown): SmokeReport {
  if (!validateReport(value)) {
    throw new Error(`Invalid smoke report: ${ajv.errorsText(validateReport.errors)}`);
  }
  const report = structuredClone(value) as SmokeReport;
  if (report.planned !== report.evaluated + report.missing) {
    throw new Error("Smoke report planned count does not equal evaluated plus missing");
  }
  for (const mode of EVALUATION_MODES) {
    const result = report.modeResults[mode];
    if (
      result.pass + result.fail + result.unavailable + result.incomplete >
      result.planned
    ) {
      throw new Error(`Smoke report ${mode} counts exceed its plan`);
    }
  }
  return report;
}

export async function assertExperimentDirectory(path: string): Promise<void> {
  const entries = await readdir(path);
  if (!entries.includes("manifest.json")) throw new Error("Experiment manifest is missing");
}

export function smokeExitCode(report: SmokeReport): 0 | 1 | 3 {
  if (
    report.missing > 0 ||
    Object.values(report.modeResults).some(
      ({ unavailable, incomplete }) => unavailable + incomplete > 0,
    )
  ) {
    return 3;
  }
  return Object.values(report.modeResults).some(({ fail }) => fail > 0) ? 1 : 0;
}
