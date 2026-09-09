import { makeBenchmarkProtocol, validateBenchmarkProtocol, type BenchmarkProtocol } from "./benchmark.js";
import type { EvaluationRoots } from "./task.js";
import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import {
  classifyTrialOutcome,
  readAttempt,
  type RunResult,
  type TrialOutcome,
} from "../artifacts/run-artifacts.js";
import { validateConfig, type LabConfig } from "../config/lab-config.js";
import {
  EVALUATION_MODES,
  mulberry32,
  readSmokeManifest,
  type EvaluationMode,
  type SmokeManifest,
  type SmokeTaskId,
} from "./smoke.js";

export const PRIMARY_CATEGORIES = [
  "incomplete-comparison",
  "correct-efficiency",
  "under-route",
  "unresolved-weak-failure",
  "correct-capability",
  "over-route",
  "missed-weak-success",
  "unresolved-strong-failure",
] as const;
export const REPLAY_THRESHOLDS = [0, 0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1] as const;

export type PrimaryCategory = (typeof PRIMARY_CATEGORIES)[number];
export type EvaluatedOutcome = "pass" | "fail";

export interface Ratio {
  numerator: number;
  denominator: number;
  value: number | null;
  excluded: number;
}

export interface Interval {
  lower: number;
  upper: number;
}

export interface ResolvedTrial {
  trialId: string;
  taskId: SmokeTaskId;
  repetition: number;
  mode: EvaluationMode;
  outcome: TrialOutcome;
  result: RunResult | null;
  physicalAttempts: RunResult[];
  incompletePhysicalAttempts: number;
}

export interface ExperimentReport {
  schemaVersion: 1;
  experimentId: string;
  manifestHash: string;
  evidenceKind: "mock" | "live";
  suite: SmokeManifest["suite"];
  split: "dev" | "heldout" | "mixed";
  seed: number;
  threshold: number;
  provenance: {
    authProfile: string;
    fingerprints: SmokeManifest["fingerprints"];
    roles: SmokeManifest["roles"];
    taskCount: number;
  };
  counts: {
    planned: number;
    evaluated: number;
    unavailable: number;
    incomplete: number;
    physicalAttempts: number;
    incompletePhysicalAttempts: number;
  };
  modes: Record<EvaluationMode, {
    planned: number;
    pass: number;
    fail: number;
    unavailable: number;
    incomplete: number;
    observedSuccess: Ratio;
    operationalCompletion: Ratio;
    plannedSuccess: Ratio;
    wilson95: Interval | null;
  }>;
  routing: {
    decisions: number;
    weak: number;
    strong: number;
    normal: number;
    fallback: number;
    weakShare: Ratio;
    normalWeakShare: Ratio;
    strongCodingShare: Ratio;
  };
  categories: {
    counts: Record<PrimaryCategory, number>;
    completeTriplets: number;
    underRouteRate: Ratio;
    underRouteCompleteTriplets: Ratio;
    overRouteRate: Ratio;
    overRouteCompleteTriplets: Ratio;
  };
  flags: {
    weakBaselinePass: number;
    weakBaselineFail: number;
    strongBaselinePass: number;
    strongBaselineFail: number;
    classifierFallback: number;
    selectedModelBaselineDisagreement: number;
    bothBaselinesFailed: number;
  };
  baselineContingency: {
    weakPassStrongPass: number;
    weakPassStrongFail: number;
    weakFailStrongPass: number;
    weakFailStrongFail: number;
    incomplete: number;
  };
  qualityDifference: {
    pairs: number;
    valuePercentagePoints: number | null;
    bootstrap95: Interval | null;
    bootstrapValidResamples: number;
    bootstrapUndefinedResamples: number;
    distinctTasks: number;
  };
  costSavings: {
    pairs: number;
    omittedPairs: number;
    value: number | null;
    bootstrap95: Interval | null;
    bootstrapValidResamples: number;
    bootstrapUndefinedResamples: number;
    distinctTasks: number;
    reason: string | null;
  };
  latency: {
    byMode: Record<EvaluationMode, {
      samples: number;
      medianAgentMs: number | null;
      p90AgentMs: number | null;
      medianValidationMs: number | null;
      medianSetupMs: number | null;
    }>;
    routedMinusStrongMs: {
      pairs: number;
      median: number | null;
      p90: number | null;
    };
    classifier: {
      samples: number;
      medianMs: number | null;
      p90Ms: number | null;
    };
  };
  usage: {
    byIdentityAndRole: Array<{
      provider: string;
      model: string;
      role: "classifier" | "coding" | "compaction";
      observedCalls: number;
      totalTokens: number | null;
      incompleteRecords: number;
    }>;
    totalExperimentTokens: number | null;
  };
  spend: {
    billingCoverage: { knownPhysicalAttempts: number; totalPhysicalAttempts: number };
    totalExperimentEstimatedCostUsd: number | null;
    totalExperimentReferenceCostUsd: number | null;
  };
  calibration: {
    samples: number;
    brierScore: number | null;
    ece: number | null;
    excludedFallback: number;
    excludedMissingProbability: number;
    excludedWeakUnavailable: number;
    bins: Array<{
      lower: number;
      upper: number;
      upperInclusive: boolean;
      count: number;
      meanProbability: number | null;
      weakPassFraction: number | null;
    }>;
  };
  tasks: Array<{
    taskId: SmokeTaskId;
    prompt: string;
    modes: Record<EvaluationMode, {
      pass: number;
      evaluated: number;
      unavailable: number;
      incomplete: number;
      passFraction: number | null;
    }>;
  }>;
  trials: Array<{
    trialId: string;
    taskId: SmokeTaskId;
    repetition: number;
    mode: EvaluationMode;
    outcome: TrialOutcome;
    selectedTier: "weak" | "strong" | null;
    classifierFallback: boolean;
    weakSolveProbability: number | null;
    physicalAttempts: number;
  }>;
  limitations: string[];
}

export interface ThresholdReplay {
  schemaVersion: 1;
  evidenceKind: "replay";
  sourceEvidenceKind: "mock" | "live";
  experimentId: string;
  sourceManifestHash: string;
  split: "dev";
  generatedAt: string;
  rows: Array<{
    threshold: number;
    planned: number;
    weakSelections: number;
    strongSelections: number;
    fallbackSelections: number;
    pass: number;
    fail: number;
    unavailable: number;
    observedSuccess: Ratio;
    estimatedCostUsd: number | null;
    costCompleteTrials: number;
    omittedCostTrials: number;
  }>;
  limitations: string[];
}

export interface FrozenPolicy {
  schemaVersion: 1 | 2;
  benchmark?: BenchmarkProtocol;
  policyId: string;
  createdAt: string;
  threshold: number;
  development: {
    experimentId: string;
    manifestHash: string;
    sourceHash: string;
    evidenceKind: "mock" | "live";
    corpusRevision: string;
  };
  provenance: {
    authProfile: string;
    capabilityCardHash: string;
    modelMetadataHash: string;
    providerConfigHash: string;
    roles: SmokeManifest["roles"];
    configurationWithoutThreshold: Omit<LabConfig, "routing"> & {
      routing: Omit<LabConfig["routing"], "weakThreshold">;
    };
  };
}

const ajv = new Ajv2020Module.default({ allErrors: true, strict: false });
const countSchema = { type: "integer", minimum: 0 } as const;
const numberOrNullSchema = { type: ["number", "null"] } as const;
const ratioSchema = {
  type: "object",
  additionalProperties: false,
  required: ["numerator", "denominator", "value", "excluded"],
  properties: {
    numerator: countSchema,
    denominator: countSchema,
    value: numberOrNullSchema,
    excluded: countSchema,
  },
} as const;
const intervalSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["lower", "upper"],
      properties: { lower: { type: "number" }, upper: { type: "number" } },
    },
  ],
} as const;
const modeSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "planned", "pass", "fail", "unavailable", "incomplete", "observedSuccess",
    "operationalCompletion", "plannedSuccess", "wilson95",
  ],
  properties: {
    planned: countSchema,
    pass: countSchema,
    fail: countSchema,
    unavailable: countSchema,
    incomplete: countSchema,
    observedSuccess: ratioSchema,
    operationalCompletion: ratioSchema,
    plannedSuccess: ratioSchema,
    wilson95: intervalSchema,
  },
} as const;
const validateReportShape = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "experimentId", "manifestHash", "evidenceKind", "suite", "split", "seed",
    "threshold", "provenance", "counts", "modes", "routing", "categories", "flags",
    "baselineContingency", "qualityDifference", "costSavings", "latency", "usage", "spend",
    "calibration", "tasks", "trials", "limitations",
  ],
  properties: {
    schemaVersion: { const: 1 },
    experimentId: { type: "string", minLength: 1 },
    manifestHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    evidenceKind: { enum: ["mock", "live"] },
    suite: { enum: ["smoke", "dev", "heldout", "full"] },
    split: { enum: ["dev", "heldout", "mixed"] },
    seed: { type: "integer", minimum: 0, maximum: 4294967295 },
    threshold: { type: "number", minimum: 0, maximum: 1 },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["authProfile", "fingerprints", "roles", "taskCount"],
      properties: {
        authProfile: { type: "string" },
        fingerprints: { type: "object" },
        roles: { type: "object" },
        taskCount: countSchema,
      },
    },
    counts: {
      type: "object",
      additionalProperties: false,
      required: [
        "planned", "evaluated", "unavailable", "incomplete", "physicalAttempts",
        "incompletePhysicalAttempts",
      ],
      properties: Object.fromEntries([
        "planned", "evaluated", "unavailable", "incomplete", "physicalAttempts",
        "incompletePhysicalAttempts",
      ].map((key) => [key, countSchema])),
    },
    modes: {
      type: "object",
      additionalProperties: false,
      required: EVALUATION_MODES,
      properties: Object.fromEntries(EVALUATION_MODES.map((mode) => [mode, modeSchema])),
    },
    routing: {
      type: "object",
      additionalProperties: false,
      required: [
        "decisions", "weak", "strong", "normal", "fallback", "weakShare",
        "normalWeakShare", "strongCodingShare",
      ],
      properties: {
        decisions: countSchema,
        weak: countSchema,
        strong: countSchema,
        normal: countSchema,
        fallback: countSchema,
        weakShare: ratioSchema,
        normalWeakShare: ratioSchema,
        strongCodingShare: ratioSchema,
      },
    },
    categories: {
      type: "object",
      additionalProperties: false,
      required: [
        "counts", "completeTriplets", "underRouteRate", "underRouteCompleteTriplets",
        "overRouteRate", "overRouteCompleteTriplets",
      ],
      properties: {
        counts: {
          type: "object",
          additionalProperties: false,
          required: PRIMARY_CATEGORIES,
          properties: Object.fromEntries(PRIMARY_CATEGORIES.map((category) => [category, countSchema])),
        },
        completeTriplets: countSchema,
        underRouteRate: ratioSchema,
        underRouteCompleteTriplets: ratioSchema,
        overRouteRate: ratioSchema,
        overRouteCompleteTriplets: ratioSchema,
      },
    },
    flags: {
      type: "object",
      additionalProperties: false,
      required: [
        "weakBaselinePass", "weakBaselineFail", "strongBaselinePass", "strongBaselineFail",
        "classifierFallback", "selectedModelBaselineDisagreement", "bothBaselinesFailed",
      ],
      properties: Object.fromEntries([
        "weakBaselinePass", "weakBaselineFail", "strongBaselinePass", "strongBaselineFail",
        "classifierFallback", "selectedModelBaselineDisagreement", "bothBaselinesFailed",
      ].map((key) => [key, countSchema])),
    },
    baselineContingency: {
      type: "object",
      additionalProperties: false,
      required: [
        "weakPassStrongPass", "weakPassStrongFail", "weakFailStrongPass",
        "weakFailStrongFail", "incomplete",
      ],
      properties: Object.fromEntries([
        "weakPassStrongPass", "weakPassStrongFail", "weakFailStrongPass",
        "weakFailStrongFail", "incomplete",
      ].map((key) => [key, countSchema])),
    },
    qualityDifference: {
      type: "object",
      additionalProperties: false,
      required: [
        "pairs", "valuePercentagePoints", "bootstrap95", "bootstrapValidResamples",
        "bootstrapUndefinedResamples", "distinctTasks",
      ],
      properties: {
        pairs: countSchema,
        valuePercentagePoints: numberOrNullSchema,
        bootstrap95: intervalSchema,
        bootstrapValidResamples: countSchema,
        bootstrapUndefinedResamples: countSchema,
        distinctTasks: countSchema,
      },
    },
    costSavings: {
      type: "object",
      additionalProperties: false,
      required: [
        "pairs", "omittedPairs", "value", "bootstrap95", "bootstrapValidResamples",
        "bootstrapUndefinedResamples", "distinctTasks", "reason",
      ],
      properties: {
        pairs: countSchema,
        omittedPairs: countSchema,
        value: numberOrNullSchema,
        bootstrap95: intervalSchema,
        bootstrapValidResamples: countSchema,
        bootstrapUndefinedResamples: countSchema,
        distinctTasks: countSchema,
        reason: { type: ["string", "null"] },
      },
    },
    latency: {
      type: "object",
      additionalProperties: false,
      required: ["byMode", "routedMinusStrongMs", "classifier"],
      properties: {
        byMode: {
          type: "object",
          additionalProperties: false,
          required: EVALUATION_MODES,
          properties: Object.fromEntries(EVALUATION_MODES.map((mode) => [mode, {
            type: "object",
            additionalProperties: false,
            required: [
              "samples", "medianAgentMs", "p90AgentMs", "medianValidationMs", "medianSetupMs",
            ],
            properties: {
              samples: countSchema,
              medianAgentMs: numberOrNullSchema,
              p90AgentMs: numberOrNullSchema,
              medianValidationMs: numberOrNullSchema,
              medianSetupMs: numberOrNullSchema,
            },
          }])),
        },
        routedMinusStrongMs: {
          type: "object",
          additionalProperties: false,
          required: ["pairs", "median", "p90"],
          properties: { pairs: countSchema, median: numberOrNullSchema, p90: numberOrNullSchema },
        },
        classifier: {
          type: "object",
          additionalProperties: false,
          required: ["samples", "medianMs", "p90Ms"],
          properties: {
            samples: countSchema,
            medianMs: numberOrNullSchema,
            p90Ms: numberOrNullSchema,
          },
        },
      },
    },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["byIdentityAndRole", "totalExperimentTokens"],
      properties: {
        byIdentityAndRole: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "provider", "model", "role", "observedCalls", "totalTokens", "incompleteRecords",
            ],
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              role: { enum: ["classifier", "coding", "compaction"] },
              observedCalls: countSchema,
              totalTokens: { type: ["integer", "null"], minimum: 0 },
              incompleteRecords: countSchema,
            },
          },
        },
        totalExperimentTokens: { type: ["integer", "null"], minimum: 0 },
      },
    },
    spend: {
      type: "object",
      additionalProperties: false,
      required: [
        "billingCoverage", "totalExperimentEstimatedCostUsd", "totalExperimentReferenceCostUsd",
      ],
      properties: {
        billingCoverage: {
          type: "object",
          additionalProperties: false,
          required: ["knownPhysicalAttempts", "totalPhysicalAttempts"],
          properties: {
            knownPhysicalAttempts: countSchema,
            totalPhysicalAttempts: countSchema,
          },
        },
        totalExperimentEstimatedCostUsd: numberOrNullSchema,
        totalExperimentReferenceCostUsd: numberOrNullSchema,
      },
    },
    calibration: {
      type: "object",
      additionalProperties: false,
      required: [
        "samples", "brierScore", "ece", "excludedFallback", "excludedMissingProbability",
        "excludedWeakUnavailable", "bins",
      ],
      properties: {
        samples: countSchema,
        brierScore: numberOrNullSchema,
        ece: numberOrNullSchema,
        excludedFallback: countSchema,
        excludedMissingProbability: countSchema,
        excludedWeakUnavailable: countSchema,
        bins: {
          type: "array",
          minItems: 5,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "lower", "upper", "upperInclusive", "count", "meanProbability",
              "weakPassFraction",
            ],
            properties: {
              lower: { type: "number" },
              upper: { type: "number" },
              upperInclusive: { type: "boolean" },
              count: countSchema,
              meanProbability: numberOrNullSchema,
              weakPassFraction: numberOrNullSchema,
            },
          },
        },
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "prompt", "modes"],
        properties: {
          taskId: { type: "string" },
          prompt: { type: "string" },
          modes: { type: "object" },
        },
      },
    },
    trials: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "trialId", "taskId", "repetition", "mode", "outcome", "selectedTier",
          "classifierFallback", "weakSolveProbability", "physicalAttempts",
        ],
        properties: {
          trialId: { type: "string" },
          taskId: { type: "string" },
          repetition: countSchema,
          mode: { enum: EVALUATION_MODES },
          outcome: { enum: ["pass", "fail", "unavailable", "incomplete"] },
          selectedTier: { enum: ["weak", "strong", null] },
          classifierFallback: { type: "boolean" },
          weakSolveProbability: numberOrNullSchema,
          physicalAttempts: countSchema,
        },
      },
    },
    limitations: { type: "array", items: { type: "string" } },
  },
});

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ratio(numerator: number, denominator: number, excluded = 0): Ratio {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    excluded,
  };
}

function isEvaluated(outcome: TrialOutcome): outcome is EvaluatedOutcome {
  return outcome === "pass" || outcome === "fail";
}

function outcomeValue(outcome: EvaluatedOutcome): number {
  return outcome === "pass" ? 1 : 0;
}

function selectedTier(trial: ResolvedTrial): "weak" | "strong" | null {
  if (trial.mode === "weak-only") return "weak";
  if (trial.mode === "strong-only") return "strong";
  return trial.result?.decision?.selectedTier ?? null;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function wilson95(successes: number, total: number): Interval | null {
  if (total === 0) return null;
  const z = 1.96;
  const probability = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (probability + zSquared / (2 * total)) / denominator;
  const margin =
    z * Math.sqrt((probability * (1 - probability) + zSquared / (4 * total)) / total) /
    denominator;
  return { lower: center - margin, upper: center + margin };
}

function clusterBootstrap(
  rows: readonly { taskId: string; numerator: number; denominator: number }[],
  seed: number,
): {
  interval: Interval | null;
  valid: number;
  undefined: number;
  distinctTasks: number;
} {
  const taskIds = [...new Set(rows.map(({ taskId }) => taskId))].sort();
  if (taskIds.length < 5) {
    return { interval: null, valid: 0, undefined: 0, distinctTasks: taskIds.length };
  }
  const grouped = new Map(
    taskIds.map((taskId) => [taskId, rows.filter((row) => row.taskId === taskId)]),
  );
  const random = mulberry32(seed);
  const samples: number[] = [];
  let undefinedSamples = 0;
  for (let iteration = 0; iteration < 2_000; iteration++) {
    let numerator = 0;
    let denominator = 0;
    for (let draw = 0; draw < taskIds.length; draw++) {
      const taskId = taskIds[Math.floor(random() * taskIds.length)]!;
      for (const row of grouped.get(taskId)!) {
        numerator += row.numerator;
        denominator += row.denominator;
      }
    }
    if (denominator === 0) undefinedSamples++;
    else samples.push(numerator / denominator);
  }
  if (samples.length < 1_000) {
    return {
      interval: null,
      valid: samples.length,
      undefined: undefinedSamples,
      distinctTasks: taskIds.length,
    };
  }
  samples.sort((left, right) => left - right);
  return {
    interval: {
      lower: samples[Math.floor((samples.length - 1) * 0.025)]!,
      upper: samples[Math.ceil((samples.length - 1) * 0.975)]!,
    },
    valid: samples.length,
    undefined: undefinedSamples,
    distinctTasks: taskIds.length,
  };
}

function primaryCategory(
  weak: ResolvedTrial | undefined,
  strong: ResolvedTrial | undefined,
  routed: ResolvedTrial | undefined,
): PrimaryCategory {
  if (!routed || !isEvaluated(routed.outcome)) return "incomplete-comparison";
  const decision = routed.result?.decision;
  if (!decision) return "incomplete-comparison";
  if (decision.selectedTier === "weak") {
    if (routed.outcome === "pass") return "correct-efficiency";
    if (!strong || !isEvaluated(strong.outcome)) return "incomplete-comparison";
    return strong.outcome === "pass" ? "under-route" : "unresolved-weak-failure";
  }
  if (!weak || !isEvaluated(weak.outcome)) return "incomplete-comparison";
  if (routed.outcome === "pass") {
    return weak.outcome === "fail" ? "correct-capability" : "over-route";
  }
  return weak.outcome === "pass" ? "missed-weak-success" : "unresolved-strong-failure";
}

function trialCost(trial: ResolvedTrial): number | null {
  if (trial.incompletePhysicalAttempts > 0 || trial.physicalAttempts.length === 0) return null;
  const costs = trial.physicalAttempts.map(({ costs }) => costs.totalEstimatedCostUsd);
  return costs.every((cost): cost is number => cost !== null)
    ? costs.reduce((total, cost) => total + cost, 0)
    : null;
}

function classifierCost(trial: ResolvedTrial): number | null {
  if (trial.incompletePhysicalAttempts > 0 || trial.physicalAttempts.length === 0) return null;
  const costs = trial.physicalAttempts.map(({ costs }) => costs.classifier.estimatedCostUsd);
  return costs.every((cost): cost is number => cost !== null)
    ? costs.reduce((total, cost) => total + cost, 0)
    : null;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  return values.every((value): value is number => value !== null)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

function aggregateUsage(trials: readonly ResolvedTrial[]) {
  const entries = new Map<string, {
    provider: string;
    model: string;
    role: "classifier" | "coding" | "compaction";
    observedCalls: number;
    totalTokens: number;
    incompleteRecords: number;
  }>();
  let total = 0;
  let totalKnown = true;
  const record = (
    provider: string,
    model: string,
    role: "classifier" | "coding" | "compaction",
    observedCalls: number,
    tokens: number | null,
  ) => {
    const key = `${provider}\0${model}\0${role}`;
    const entry = entries.get(key) ?? {
      provider,
      model,
      role,
      observedCalls: 0,
      totalTokens: 0,
      incompleteRecords: 0,
    };
    entry.observedCalls += observedCalls;
    if (tokens === null) entry.incompleteRecords++;
    else entry.totalTokens += tokens;
    entries.set(key, entry);
  };
  for (const trial of trials) {
    if (trial.incompletePhysicalAttempts > 0) totalKnown = false;
    for (const attempt of trial.physicalAttempts) {
      if (attempt.usage.total.totalTokens === null) totalKnown = false;
      else total += attempt.usage.total.totalTokens;
      const classifier = attempt.provenance.models.classifier;
      record(
        classifier.provider,
        classifier.model,
        "classifier",
        attempt.usage.classifier.observedCalls,
        attempt.usage.classifier.totalTokens,
      );
      const tier = attempt.decision?.selectedTier ??
        (attempt.mode === "strong-only" ? "strong" : attempt.mode === "weak-only" ? "weak" : null);
      if (tier) {
        const coding = attempt.provenance.models[tier];
        record(
          coding.provider,
          coding.model,
          "coding",
          attempt.usage.coding.observedCalls,
          attempt.usage.coding.totalTokens,
        );
        record(
          coding.provider,
          coding.model,
          "compaction",
          attempt.usage.compaction.observedCalls,
          attempt.usage.compaction.totalTokens,
        );
      }
    }
  }
  return {
    byIdentityAndRole: [...entries.values()]
      .sort((left, right) =>
        `${left.provider}/${left.model}/${left.role}`.localeCompare(
          `${right.provider}/${right.model}/${right.role}`,
        ),
      )
      .map((entry) => ({
        ...entry,
        totalTokens: entry.incompleteRecords === 0 ? entry.totalTokens : null,
      })),
    totalExperimentTokens: totalKnown ? total : null,
  };
}

function validateFinite(value: unknown, path = "report"): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${path} contains a non-finite number`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateFinite(entry, `${path}[${index}]`));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) validateFinite(entry, `${path}.${key}`);
  }
}

export function aggregateExperiment(
  manifest: SmokeManifest,
  trials: readonly ResolvedTrial[],
): ExperimentReport {
  if (trials.some(({ result }) => result && result.evidenceKind !== manifest.evidenceKind)) {
    throw new Error("Mixed evidence kinds are not comparable");
  }
  if (trials.some((trial) =>
    trial.mode === "routed" &&
    trial.result?.decision &&
    !["classifier", "classifier-fallback"].includes(trial.result.decision.source)
  )) {
    throw new Error("Routed trials require classifier or classifier-fallback decisions");
  }
  const byPair = new Map<string, Partial<Record<EvaluationMode, ResolvedTrial>>>();
  for (const trial of trials) {
    const key = `${trial.taskId}\0${trial.repetition}`;
    const group = byPair.get(key) ?? {};
    if (group[trial.mode]) throw new Error(`Duplicate logical trial ${trial.trialId}`);
    group[trial.mode] = trial;
    byPair.set(key, group);
  }
  const categories = Object.fromEntries(
    PRIMARY_CATEGORIES.map((category) => [category, 0]),
  ) as Record<PrimaryCategory, number>;
  const contingency = {
    weakPassStrongPass: 0,
    weakPassStrongFail: 0,
    weakFailStrongPass: 0,
    weakFailStrongFail: 0,
    incomplete: 0,
  };
  const flags = {
    weakBaselinePass: 0,
    weakBaselineFail: 0,
    strongBaselinePass: 0,
    strongBaselineFail: 0,
    classifierFallback: 0,
    selectedModelBaselineDisagreement: 0,
    bothBaselinesFailed: 0,
  };
  const qualityRows: Array<{ taskId: string; numerator: number; denominator: number }> = [];
  const costRows: Array<{ taskId: string; numerator: number; denominator: number }> = [];
  const latencyDifferences: number[] = [];
  let completeTriplets = 0;
  let underDenominator = 0;
  let overDenominator = 0;
  let underCompleteCount = 0;
  let overCompleteCount = 0;
  let omittedCostPairs = 0;
  for (const group of byPair.values()) {
    const weak = group["weak-only"];
    const strong = group["strong-only"];
    const routed = group.routed;
    const category = primaryCategory(weak, strong, routed);
    categories[category]++;
    const complete = Boolean(
      weak && strong && routed &&
      isEvaluated(weak.outcome) && isEvaluated(strong.outcome) && isEvaluated(routed.outcome) &&
      routed.result?.decision,
    );
    if (complete) completeTriplets++;
    if (complete && category === "under-route") underCompleteCount++;
    if (complete && category === "over-route") overCompleteCount++;
    if (weak && isEvaluated(weak.outcome)) flags[weak.outcome === "pass" ? "weakBaselinePass" : "weakBaselineFail"]++;
    if (strong && isEvaluated(strong.outcome)) flags[strong.outcome === "pass" ? "strongBaselinePass" : "strongBaselineFail"]++;
    if (routed?.result?.decision?.source === "classifier-fallback") flags.classifierFallback++;
    if (weak && strong && isEvaluated(weak.outcome) && isEvaluated(strong.outcome)) {
      if (weak.outcome === "pass" && strong.outcome === "pass") contingency.weakPassStrongPass++;
      else if (weak.outcome === "pass") contingency.weakPassStrongFail++;
      else if (strong.outcome === "pass") contingency.weakFailStrongPass++;
      else {
        contingency.weakFailStrongFail++;
        flags.bothBaselinesFailed++;
      }
    } else contingency.incomplete++;
    if (routed?.result?.decision && isEvaluated(routed.outcome)) {
      const baseline = routed.result.decision.selectedTier === "weak" ? weak : strong;
      if (baseline && isEvaluated(baseline.outcome) && baseline.outcome !== routed.outcome) {
        flags.selectedModelBaselineDisagreement++;
      }
      if (
        routed.result.decision.selectedTier === "weak" &&
        strong && isEvaluated(strong.outcome)
      ) {
        underDenominator++;
      }
      if (
        routed.result.decision.selectedTier === "strong" &&
        weak && isEvaluated(weak.outcome)
      ) {
        overDenominator++;
      }
    }
    if (routed && strong && isEvaluated(routed.outcome) && isEvaluated(strong.outcome)) {
      qualityRows.push({
        taskId: routed.taskId,
        numerator: outcomeValue(routed.outcome) - outcomeValue(strong.outcome),
        denominator: 1,
      });
      const routedCost = trialCost(routed);
      const strongCost = trialCost(strong);
      if (routedCost !== null && strongCost !== null) {
        costRows.push({
          taskId: routed.taskId,
          numerator: strongCost - routedCost,
          denominator: strongCost,
        });
      } else omittedCostPairs++;
      const routedLatency = routed.result?.durationsMs.agent;
      const strongLatency = strong.result?.durationsMs.agent;
      if (routedLatency !== null && routedLatency !== undefined &&
          strongLatency !== null && strongLatency !== undefined) {
        latencyDifferences.push(routedLatency - strongLatency);
      }
    }
  }
  const modes = Object.fromEntries(EVALUATION_MODES.map((mode) => {
    const selected = trials.filter((trial) => trial.mode === mode);
    const pass = selected.filter(({ outcome }) => outcome === "pass").length;
    const fail = selected.filter(({ outcome }) => outcome === "fail").length;
    const unavailable = selected.filter(({ outcome }) => outcome === "unavailable").length;
    const incomplete = selected.filter(({ outcome }) => outcome === "incomplete").length;
    const planned = manifest.tasks.length * manifest.repetitions;
    return [mode, {
      planned,
      pass,
      fail,
      unavailable,
      incomplete,
      observedSuccess: ratio(pass, pass + fail, unavailable + incomplete),
      operationalCompletion: ratio(pass + fail, planned),
      plannedSuccess: ratio(pass, planned),
      wilson95: wilson95(pass, pass + fail),
    }];
  })) as ExperimentReport["modes"];
  const routedTrials = trials.filter(({ mode }) => mode === "routed");
  const routedDecisions = routedTrials.filter(({ result }) => result?.decision);
  const weakDecisions = routedDecisions.filter(({ result }) => result!.decision!.selectedTier === "weak");
  const normalDecisions = routedDecisions.filter(({ result }) => result!.decision!.source === "classifier");
  const physicalCodingAttempts = trials.flatMap(({ physicalAttempts }) => physicalAttempts)
    .map((attempt) => ({
      tier: attempt.decision?.selectedTier ??
        (attempt.mode === "strong-only" ? "strong" : attempt.mode === "weak-only" ? "weak" : null),
    }))
    .filter((attempt): attempt is { tier: "weak" | "strong" } => attempt.tier !== null);
  const strongSelections = physicalCodingAttempts.filter(({ tier }) => tier === "strong").length;
  const underRoutes = categories["under-route"];
  const overRoutes = categories["over-route"];
  const qualitySum = qualityRows.reduce((sum, row) => sum + row.numerator, 0);
  const costNumerator = costRows.reduce((sum, row) => sum + row.numerator, 0);
  const costDenominator = costRows.reduce((sum, row) => sum + row.denominator, 0);
  const qualityBootstrap = clusterBootstrap(qualityRows, manifest.seed);
  const costBootstrap = clusterBootstrap(costRows, manifest.seed);
  const calibrationRows: Array<{ probability: number; label: number }> = [];
  let excludedFallback = 0;
  let excludedMissingProbability = 0;
  let excludedWeakUnavailable = 0;
  for (const group of byPair.values()) {
    const routed = group.routed;
    if (!routed?.result?.decision) continue;
    if (routed.result.decision.source === "classifier-fallback") {
      excludedFallback++;
      continue;
    }
    const probability = routed.result.decision.weakSolveProbability;
    if (probability === null) {
      excludedMissingProbability++;
      continue;
    }
    const weak = group["weak-only"];
    if (!weak || !isEvaluated(weak.outcome)) {
      excludedWeakUnavailable++;
      continue;
    }
    calibrationRows.push({ probability, label: outcomeValue(weak.outcome) });
  }
  const bins = Array.from({ length: 5 }, (_, index) => {
    const lower = index * 0.2;
    const upper = (index + 1) * 0.2;
    const selected = calibrationRows.filter(({ probability }) =>
      probability >= lower && (index === 4 ? probability <= upper : probability < upper),
    );
    return {
      lower,
      upper,
      upperInclusive: index === 4,
      count: selected.length,
      meanProbability: selected.length === 0
        ? null
        : selected.reduce((sum, row) => sum + row.probability, 0) / selected.length,
      weakPassFraction: selected.length === 0
        ? null
        : selected.reduce((sum, row) => sum + row.label, 0) / selected.length,
    };
  });
  const brier = calibrationRows.length === 0
    ? null
    : calibrationRows.reduce(
      (sum, row) => sum + (row.probability - row.label) ** 2,
      0,
    ) / calibrationRows.length;
  const ece = calibrationRows.length === 0
    ? null
    : bins.reduce(
      (sum, bin) => sum + (
        bin.count === 0
          ? 0
          : bin.count / calibrationRows.length *
            Math.abs(bin.meanProbability! - bin.weakPassFraction!)
      ),
      0,
    );
  const latencyByMode = Object.fromEntries(EVALUATION_MODES.map((mode) => {
    const selected = trials.filter(({ mode: trialMode, result }) => trialMode === mode && result);
    const agent = selected.flatMap(({ result }) =>
      result!.durationsMs.agent === null ? [] : [result!.durationsMs.agent]);
    const validation = selected.flatMap(({ result }) =>
      result!.durationsMs.validation === null ? [] : [result!.durationsMs.validation]);
    const setup = selected.map(({ result }) => result!.durationsMs.setup);
    return [mode, {
      samples: agent.length,
      medianAgentMs: median(agent),
      p90AgentMs: percentile(agent, 0.9),
      medianValidationMs: median(validation),
      medianSetupMs: median(setup),
    }];
  })) as ExperimentReport["latency"]["byMode"];
  const classifierDurations = routedDecisions.flatMap(({ result }) =>
    result!.decision!.classifier === null ? [] : [result!.decision!.classifier.durationMs]);
  const usage = aggregateUsage(trials);
  const physical = trials.flatMap(({ physicalAttempts }) => physicalAttempts);
  const incompletePhysical = trials.reduce(
    (sum, trial) => sum + trial.incompletePhysicalAttempts,
    0,
  );
  const estimatedCosts = physical.map(({ costs }) => costs.totalEstimatedCostUsd);
  const referenceCosts = physical.map(({ costs }) => costs.totalReferenceCostUsd);
  const taskRows = manifest.tasks.map((task) => ({
    taskId: task.id,
    prompt: task.publicPrompt,
    modes: Object.fromEntries(EVALUATION_MODES.map((mode) => {
      const selected = trials.filter((trial) => trial.taskId === task.id && trial.mode === mode);
      const pass = selected.filter(({ outcome }) => outcome === "pass").length;
      const evaluated = selected.filter(({ outcome }) => isEvaluated(outcome)).length;
      return [mode, {
        pass,
        evaluated,
        unavailable: selected.filter(({ outcome }) => outcome === "unavailable").length,
        incomplete: selected.filter(({ outcome }) => outcome === "incomplete").length,
        passFraction: evaluated === 0 ? null : pass / evaluated,
      }];
    })) as ExperimentReport["tasks"][number]["modes"],
  }));
  const report: ExperimentReport = {
    schemaVersion: 1,
    experimentId: manifest.experimentId,
    manifestHash: manifest.manifestHash,
    evidenceKind: manifest.evidenceKind,
    suite: manifest.suite,
    split: manifest.suite === "heldout" ? "heldout" : manifest.suite === "full" ? "mixed" : "dev",
    seed: manifest.seed,
    threshold: manifest.threshold,
    provenance: {
      authProfile: manifest.authProfile,
      fingerprints: structuredClone(manifest.fingerprints),
      roles: structuredClone(manifest.roles),
      taskCount: manifest.tasks.length,
    },
    counts: {
      planned: manifest.schedule.length,
      evaluated: trials.filter(({ outcome }) => isEvaluated(outcome)).length,
      unavailable: trials.filter(({ outcome }) => outcome === "unavailable").length,
      incomplete: manifest.schedule.length -
        trials.filter(({ outcome }) => outcome !== "incomplete").length,
      physicalAttempts: physical.length,
      incompletePhysicalAttempts: incompletePhysical,
    },
    modes,
    routing: {
      decisions: routedDecisions.length,
      weak: weakDecisions.length,
      strong: routedDecisions.length - weakDecisions.length,
      normal: normalDecisions.length,
      fallback: routedDecisions.length - normalDecisions.length,
      weakShare: ratio(weakDecisions.length, routedDecisions.length),
      normalWeakShare: ratio(
        normalDecisions.filter(({ result }) => result!.decision!.selectedTier === "weak").length,
        normalDecisions.length,
      ),
      strongCodingShare: ratio(
        strongSelections,
        physicalCodingAttempts.length,
        trials.reduce((sum, trial) => sum + trial.incompletePhysicalAttempts, 0),
      ),
    },
    categories: {
      counts: categories,
      completeTriplets,
      underRouteRate: ratio(underRoutes, underDenominator),
      underRouteCompleteTriplets: ratio(underCompleteCount, completeTriplets),
      overRouteRate: ratio(overRoutes, overDenominator),
      overRouteCompleteTriplets: ratio(overCompleteCount, completeTriplets),
    },
    flags,
    baselineContingency: contingency,
    qualityDifference: {
      pairs: qualityRows.length,
      valuePercentagePoints: qualityRows.length === 0 ? null : qualitySum / qualityRows.length * 100,
      bootstrap95: qualityBootstrap.interval === null ? null : {
        lower: qualityBootstrap.interval.lower * 100,
        upper: qualityBootstrap.interval.upper * 100,
      },
      bootstrapValidResamples: qualityBootstrap.valid,
      bootstrapUndefinedResamples: qualityBootstrap.undefined,
      distinctTasks: qualityBootstrap.distinctTasks,
    },
    costSavings: {
      pairs: costRows.length,
      omittedPairs: omittedCostPairs,
      value: costDenominator > 0 ? costNumerator / costDenominator : null,
      bootstrap95: costBootstrap.interval,
      bootstrapValidResamples: costBootstrap.valid,
      bootstrapUndefinedResamples: costBootstrap.undefined,
      distinctTasks: costBootstrap.distinctTasks,
      reason: costRows.length === 0
        ? "No matched pair has complete per-token cost evidence."
        : costDenominator === 0
          ? "Matched strong-only cost denominator is zero."
          : null,
    },
    latency: {
      byMode: latencyByMode,
      routedMinusStrongMs: {
        pairs: latencyDifferences.length,
        median: median(latencyDifferences),
        p90: percentile(latencyDifferences, 0.9),
      },
      classifier: {
        samples: classifierDurations.length,
        medianMs: median(classifierDurations),
        p90Ms: percentile(classifierDurations, 0.9),
      },
    },
    usage,
    spend: {
      billingCoverage: {
        knownPhysicalAttempts: estimatedCosts.filter((cost) => cost !== null).length,
        totalPhysicalAttempts: physical.length + incompletePhysical,
      },
      totalExperimentEstimatedCostUsd:
        incompletePhysical === 0 ? sumKnown(estimatedCosts) : null,
      totalExperimentReferenceCostUsd:
        incompletePhysical === 0 ? sumKnown(referenceCosts) : null,
    },
    calibration: {
      samples: calibrationRows.length,
      brierScore: brier,
      ece,
      excludedFallback,
      excludedMissingProbability,
      excludedWeakUnavailable,
      bins,
    },
    tasks: taskRows,
    trials: trials.map((trial) => ({
      trialId: trial.trialId,
      taskId: trial.taskId,
      repetition: trial.repetition,
      mode: trial.mode,
      outcome: trial.outcome,
      selectedTier: selectedTier(trial),
      classifierFallback: trial.result?.decision?.source === "classifier-fallback",
      weakSolveProbability: trial.result?.decision?.weakSolveProbability ?? null,
      physicalAttempts: trial.physicalAttempts.length + trial.incompletePhysicalAttempts,
    })),
    limitations: [
      ...(manifest.evidenceKind === "mock"
        ? ["Mock evidence validates integration only and does not measure live model capability."]
        : []),
      ...(manifest.suite === "smoke"
        ? ["Smoke results are not statistically conclusive."]
        : []),
      ...(qualityBootstrap.distinctTasks < 5
        ? ["Quality bootstrap interval is unavailable with fewer than five eligible tasks."]
        : []),
      ...(costBootstrap.distinctTasks < 5
        ? ["Cost bootstrap interval is unavailable with fewer than five cost-complete tasks."]
        : []),
      "Trials on the same task are correlated; Wilson intervals are descriptive.",
      "ECE is sample-size-sensitive and classifier probabilities are forecasts, not capability evidence.",
      "Subscription and unknown billing remain null; reference prices are not measured spend or savings.",
    ],
  };
  return validateExperimentReport(report);
}

export function validateExperimentReport(value: unknown): ExperimentReport {
  validateFinite(value);
  if (!validateReportShape(value)) {
    throw new Error(`Invalid experiment report: ${ajv.errorsText(validateReportShape.errors)}`);
  }
  const report = structuredClone(value) as ExperimentReport;
  if (
    report.counts.evaluated + report.counts.unavailable + report.counts.incomplete !==
      report.counts.planned ||
    report.routing.weak + report.routing.strong !== report.routing.decisions ||
    report.routing.normal + report.routing.fallback !== report.routing.decisions
  ) {
    throw new Error("Experiment report aggregate counts are inconsistent");
  }
  return report;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function loadExperimentRecords(
  experimentDirectory: string,
): Promise<{ manifest: SmokeManifest; trials: ResolvedTrial[] }> {
  const manifest = await readSmokeManifest(join(experimentDirectory, "manifest.json"));
  const trials: ResolvedTrial[] = [];
  for (const scheduled of manifest.schedule) {
    const physicalAttempts: RunResult[] = [];
    let incompletePhysicalAttempts = 0;
    let selected: RunResult | null = null;
    for (const attemptId of scheduled.attemptIds) {
      const directory = join(experimentDirectory, "attempts", attemptId);
      if (!(await exists(directory))) break;
      const attempt = await readAttempt(directory);
      if (attempt.status !== "finalized" || attempt.result === null) {
        incompletePhysicalAttempts++;
        continue;
      }
      const result = attempt.result;
      if (
        result.identity.experimentId !== manifest.experimentId ||
        result.identity.taskId !== scheduled.taskId ||
        result.identity.repetition !== scheduled.repetition ||
        result.identity.attemptId !== attemptId ||
        result.mode !== scheduled.mode
      ) {
        throw new Error(`Attempt identity mismatch for ${attemptId}`);
      }
      if (result.evidenceKind !== manifest.evidenceKind) {
        throw new Error(`Mixed evidence kind in attempt ${attemptId}`);
      }
      if (
        scheduled.mode === "routed" &&
        result.decision &&
        !["classifier", "classifier-fallback"].includes(result.decision.source)
      ) {
        throw new Error(`Routed attempt ${attemptId} has an invalid decision source`);
      }
      if (
        result.provenance.configHash !== manifest.fingerprints.configHash ||
        result.provenance.capabilityCardHash !== manifest.fingerprints.capabilityCardHash ||
        result.provenance.modelMetadataHash !== manifest.fingerprints.modelMetadataHash ||
        result.provenance.providerConfigHash !== manifest.fingerprints.providerConfigHash ||
        result.provenance.authProfile !== manifest.authProfile
      ) {
        throw new Error(`Attempt cohort fingerprint mismatch for ${attemptId}`);
      }
      const task = manifest.tasks.find(({ id }) => id === scheduled.taskId)!;
      if (
        result.provenance.taskHash !== task.taskHash ||
        result.provenance.sourceHash !== task.sourceHash ||
        result.provenance.validatorHash !== task.validatorHash
      ) {
        throw new Error(`Attempt task provenance mismatch for ${attemptId}`);
      }
      physicalAttempts.push(result);
      selected = result;
      if (isEvaluated(classifyTrialOutcome(result))) break;
    }
    trials.push({
      trialId: scheduled.trialId,
      taskId: scheduled.taskId,
      repetition: scheduled.repetition,
      mode: scheduled.mode,
      outcome: selected ? classifyTrialOutcome(selected) : "incomplete",
      result: selected,
      physicalAttempts,
      incompletePhysicalAttempts,
    });
  }
  return { manifest, trials };
}

function markdown(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u009b]/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function displayRatio(value: Ratio): string {
  return `${value.numerator}/${value.denominator}` +
    (value.value === null ? " (undefined)" : ` (${(value.value * 100).toFixed(1)}%)`);
}

export function renderExperimentMarkdown(report: ExperimentReport): string {
  const lines = [
    `# ${markdown(report.suite)} routing analysis: ${markdown(report.experimentId)}`,
    "",
    "## Provenance",
    "",
    `Evidence kind: **${report.evidenceKind}**. Split: **${report.split}**. ` +
      `Threshold: ${report.threshold}. Profile: \`${markdown(report.provenance.authProfile)}\`.`,
    "",
    ...(["classifier", "weak", "strong"] as const).map((role) => {
      const model = report.provenance.roles[role];
      return `- ${role}: \`${markdown(model.provider)}/${markdown(model.model)}\` (${model.billing})`;
    }),
    "",
    "## Completion and success",
    "",
    "| Mode | PASS | FAIL | Unavailable | Incomplete | Observed success | Operational completion | Planned success |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...EVALUATION_MODES.map((mode) => {
      const entry = report.modes[mode];
      return `| ${mode} | ${entry.pass} | ${entry.fail} | ${entry.unavailable} | ${entry.incomplete} | ` +
        `${displayRatio(entry.observedSuccess)} | ${displayRatio(entry.operationalCompletion)} | ` +
        `${displayRatio(entry.plannedSuccess)} |`;
    }),
    "",
    "## Routing outcomes",
    "",
    `Weak decisions: ${report.routing.weak}; strong decisions: ${report.routing.strong}; ` +
      `fallbacks: ${report.routing.fallback}; weak share: ${displayRatio(report.routing.weakShare)}.`,
    "",
    `Strong coding-session share: ${displayRatio(report.routing.strongCodingShare)}. ` +
      `Under-route rate: ${displayRatio(report.categories.underRouteRate)}. ` +
      `Over-route rate: ${displayRatio(report.categories.overRouteRate)}.`,
    "",
    "| Category | Count |",
    "|---|---:|",
    ...PRIMARY_CATEGORIES.map((category) => `| ${category} | ${report.categories.counts[category]} |`),
    "",
    "## Quality and efficiency",
    "",
    `Paired routed-minus-strong quality: ${report.qualityDifference.valuePercentagePoints ?? "undefined"} ` +
      `percentage points over ${report.qualityDifference.pairs} pair(s).`,
    "",
    `Paired cost savings: ${report.costSavings.value === null
      ? "undefined"
      : `${(report.costSavings.value * 100).toFixed(1)}%`} over ${report.costSavings.pairs} ` +
      `cost-complete pair(s); ${report.costSavings.omittedPairs} omitted.`,
    "",
    `Routed-minus-strong agent latency: median ${report.latency.routedMinusStrongMs.median ?? "unknown"} ms, ` +
      `p90 ${report.latency.routedMinusStrongMs.p90 ?? "unknown"} ms over ` +
      `${report.latency.routedMinusStrongMs.pairs} pair(s). Classifier median: ` +
      `${report.latency.classifier.medianMs ?? "unknown"} ms.`,
    "",
    "### Baseline contingency",
    "",
    `Weak PASS/strong PASS: ${report.baselineContingency.weakPassStrongPass}; ` +
      `weak PASS/strong FAIL: ${report.baselineContingency.weakPassStrongFail}; ` +
      `weak FAIL/strong PASS: ${report.baselineContingency.weakFailStrongPass}; ` +
      `weak FAIL/strong FAIL: ${report.baselineContingency.weakFailStrongFail}; ` +
      `incomplete: ${report.baselineContingency.incomplete}.`,
    "",
    "### Provider usage",
    "",
    "| Provider/model | Role | Calls | Tokens | Incomplete records |",
    "|---|---|---:|---:|---:|",
    ...report.usage.byIdentityAndRole.map((entry) =>
      `| ${markdown(`${entry.provider}/${entry.model}`)} | ${entry.role} | ${entry.observedCalls} | ` +
      `${entry.totalTokens ?? "unknown"} | ${entry.incompleteRecords} |`,
    ),
    "",
    `Known estimated spend: ${report.spend.totalExperimentEstimatedCostUsd ?? "unknown"} USD; ` +
      `reference-only total: ${report.spend.totalExperimentReferenceCostUsd ?? "unknown"} USD.`,
    "",
    "## Task outcomes",
    "",
    "| Task | Public prompt | Weak | Strong | Routed |",
    "|---|---|---:|---:|---:|",
    ...report.tasks.map((task) => `| ${task.taskId} | ${markdown(task.prompt)} | ` +
      `${task.modes["weak-only"].pass}/${task.modes["weak-only"].evaluated} | ` +
      `${task.modes["strong-only"].pass}/${task.modes["strong-only"].evaluated} | ` +
      `${task.modes.routed.pass}/${task.modes.routed.evaluated} |`),
    "",
    "## Confidence calibration",
    "",
    `Samples: ${report.calibration.samples}; Brier: ${report.calibration.brierScore ?? "undefined"}; ` +
      `ECE: ${report.calibration.ece ?? "undefined"}; fallback exclusions: ` +
      `${report.calibration.excludedFallback}.`,
    "",
    "| Bin | Count | Mean probability | Weak pass fraction |",
    "|---|---:|---:|---:|",
    ...report.calibration.bins.map((bin) =>
      `| [${bin.lower}, ${bin.upper}${bin.upperInclusive ? "]" : ")"} | ${bin.count} | ` +
      `${bin.meanProbability ?? "n/a"} | ${bin.weakPassFraction ?? "n/a"} |`,
    ),
    "",
    "## Uncertainty",
    "",
    `Quality task-cluster bootstrap: ${report.qualityDifference.bootstrap95
      ? `${report.qualityDifference.bootstrap95.lower} to ${report.qualityDifference.bootstrap95.upper} percentage points`
      : "insufficient sample"}.`,
    "",
    `Cost task-cluster bootstrap: ${report.costSavings.bootstrap95
      ? `${report.costSavings.bootstrap95.lower} to ${report.costSavings.bootstrap95.upper}`
      : "insufficient sample or cost coverage"}.`,
    "",
    "## Limitations",
    "",
    ...report.limitations.map((limitation) => `- ${markdown(limitation)}`),
    "",
  ];
  return lines.join("\n");
}

function terminal(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

export function renderExperimentTerminal(report: ExperimentReport): string {
  return [
    `Routing analysis ${terminal(report.experimentId)}`,
    `evidence=${report.evidenceKind} split=${report.split} suite=${report.suite} threshold=${report.threshold}`,
    ...(["classifier", "weak", "strong"] as const).map((role) => {
      const model = report.provenance.roles[role];
      return `${role}=${terminal(model.provider)}/${terminal(model.model)} billing=${model.billing}`;
    }),
    ...EVALUATION_MODES.map((mode) => {
      const result = report.modes[mode];
      return `${mode}: pass=${result.pass} fail=${result.fail} unavailable=${result.unavailable} ` +
        `incomplete=${result.incomplete} success=${result.observedSuccess.numerator}/` +
        `${result.observedSuccess.denominator}`;
    }),
    `routing: weak=${report.routing.weak} strong=${report.routing.strong} ` +
      `fallback=${report.routing.fallback} strong-coding-share=` +
      `${report.routing.strongCodingShare.numerator}/${report.routing.strongCodingShare.denominator}`,
    `categories: ${PRIMARY_CATEGORIES.map((category) =>
      `${category}=${report.categories.counts[category]}`).join(" ")}`,
    `routing-errors: under=${report.categories.underRouteRate.numerator}/` +
      `${report.categories.underRouteRate.denominator} over=${report.categories.overRouteRate.numerator}/` +
      `${report.categories.overRouteRate.denominator}`,
    `quality: routed-minus-strong-pp=${report.qualityDifference.valuePercentagePoints ?? "undefined"} ` +
      `pairs=${report.qualityDifference.pairs}`,
    `cost-savings=${report.costSavings.value ?? "undefined"} pairs=${report.costSavings.pairs} ` +
      `omitted=${report.costSavings.omittedPairs}`,
    `calibration: samples=${report.calibration.samples} brier=${report.calibration.brierScore ?? "undefined"} ` +
      `ece=${report.calibration.ece ?? "undefined"}`,
    `latency: routed-minus-strong-median-ms=${report.latency.routedMinusStrongMs.median ?? "unknown"} ` +
      `p90-ms=${report.latency.routedMinusStrongMs.p90 ?? "unknown"} ` +
      `classifier-median-ms=${report.latency.classifier.medianMs ?? "unknown"}`,
    `usage: total-tokens=${report.usage.totalExperimentTokens ?? "unknown"} ` +
      `estimated-spend-usd=${report.spend.totalExperimentEstimatedCostUsd ?? "unknown"} ` +
      `cost-coverage=${report.spend.billingCoverage.knownPhysicalAttempts}/` +
      `${report.spend.billingCoverage.totalPhysicalAttempts}`,
    `limitations=${report.limitations.map(terminal).join(" | ")}`,
  ].join("\n");
}

async function durableWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function generateExperimentReport(
  experimentDirectory: string,
): Promise<ExperimentReport> {
  const { manifest, trials } = await loadExperimentRecords(experimentDirectory);
  const report = aggregateExperiment(manifest, trials);
  await durableWrite(
    join(experimentDirectory, "experiment.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await durableWrite(join(experimentDirectory, "experiment.md"), renderExperimentMarkdown(report));
  return report;
}

function developmentSourceHash(manifest: SmokeManifest, trials: readonly ResolvedTrial[]): string {
  return hash({
    manifestHash: manifest.manifestHash,
    trials: trials.map((trial) => ({
      trialId: trial.trialId,
      attempts: trial.physicalAttempts,
      incompletePhysicalAttempts: trial.incompletePhysicalAttempts,
    })),
  });
}

function replayMarkdown(replay: ThresholdReplay): string {
  return [
    `# Threshold replay: ${markdown(replay.experimentId)}`,
    "",
    "**Evidence kind: replay. These rows are hypothetical and make no provider calls.**",
    "",
    "| Threshold | Weak | Strong | Fallback | PASS | FAIL | Unavailable | Observed success | Estimated USD |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...replay.rows.map((row) =>
      `| ${row.threshold} | ${row.weakSelections} | ${row.strongSelections} | ` +
      `${row.fallbackSelections} | ${row.pass} | ${row.fail} | ${row.unavailable} | ` +
      `${displayRatio(row.observedSuccess)} | ${row.estimatedCostUsd ?? "unknown"} |`,
    ),
    "",
    ...replay.limitations.map((limitation) => `- ${markdown(limitation)}`),
    "",
  ].join("\n");
}

export function replayThresholds(
  manifest: SmokeManifest,
  trials: readonly ResolvedTrial[],
): ThresholdReplay {
  if (manifest.suite !== "dev") {
    throw new Error("Threshold replay is development-only; use --split dev with a dev experiment");
  }
  const byPair = new Map<string, Partial<Record<EvaluationMode, ResolvedTrial>>>();
  for (const trial of trials) {
    const key = `${trial.taskId}\0${trial.repetition}`;
    const group = byPair.get(key) ?? {};
    group[trial.mode] = trial;
    byPair.set(key, group);
  }
  const rows = REPLAY_THRESHOLDS.map((threshold) => {
    let weakSelections = 0;
    let strongSelections = 0;
    let fallbackSelections = 0;
    let pass = 0;
    let fail = 0;
    let unavailable = 0;
    const costs: Array<number | null> = [];
    for (const group of byPair.values()) {
      const routed = group.routed;
      const decision = routed?.result?.decision;
      if (!decision) {
        unavailable++;
        costs.push(null);
        continue;
      }
      let selected: "weak" | "strong";
      if (decision.source === "classifier-fallback" || decision.weakSolveProbability === null) {
        selected = "strong";
        fallbackSelections++;
      } else {
        selected = decision.weakSolveProbability >= threshold ? "weak" : "strong";
      }
      if (selected === "weak") weakSelections++;
      else strongSelections++;
      const baseline = group[selected === "weak" ? "weak-only" : "strong-only"];
      if (!baseline || !isEvaluated(baseline.outcome)) unavailable++;
      else if (baseline.outcome === "pass") pass++;
      else fail++;
      const baselineCost = baseline ? trialCost(baseline) : null;
      const overhead = routed ? classifierCost(routed) : null;
      costs.push(
        baselineCost === null || overhead === null ? null : baselineCost + overhead,
      );
    }
    return {
      threshold,
      planned: byPair.size,
      weakSelections,
      strongSelections,
      fallbackSelections,
      pass,
      fail,
      unavailable,
      observedSuccess: ratio(pass, pass + fail, unavailable),
      estimatedCostUsd: sumKnown(costs),
      costCompleteTrials: costs.filter((cost) => cost !== null).length,
      omittedCostTrials: costs.filter((cost) => cost === null).length,
    };
  });
  return {
    schemaVersion: 1,
    evidenceKind: "replay",
    sourceEvidenceKind: manifest.evidenceKind,
    experimentId: manifest.experimentId,
    sourceManifestHash: manifest.manifestHash,
    split: "dev",
    generatedAt: new Date().toISOString(),
    rows,
    limitations: [
      "Replay selects recorded weak-only or strong-only outcomes; it is not a fresh routed coding run.",
      "Fallback classifier verdicts remain strong at every threshold.",
      "Replay costs include observed classifier overhead and all physical attempts of the selected baseline.",
      "Unknown, subscription, or incomplete cost evidence remains null rather than zero.",
    ],
  };
}

export async function generateThresholdReplay(
  experimentDirectory: string,
  split: string,
  outputDirectory?: string,
): Promise<{ directory: string; replay: ThresholdReplay }> {
  if (split !== "dev") throw new Error("Threshold replay requires --split dev");
  const { manifest, trials } = await loadExperimentRecords(experimentDirectory);
  const replay = replayThresholds(manifest, trials);
  const directory = outputDirectory ??
    join(dirname(experimentDirectory), `${basename(experimentDirectory)}-threshold-replay`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await durableWrite(join(directory, "threshold-replay.json"), `${JSON.stringify(replay, null, 2)}\n`);
  await durableWrite(join(directory, "threshold-replay.md"), replayMarkdown(replay));
  const control = randomSelectionReplay(manifest, trials);
  await durableWrite(join(directory, "random-selection-replay.json"), `${JSON.stringify(control, null, 2)}\n`);
  await durableWrite(join(directory, "random-selection-replay.md"), `# Random selection replay\n\nCounterfactual replay from ${control.sourceEvidenceKind} development evidence.\n\nWeak selections: ${control.weakSelections}/${control.recordedDecisions}. Pass: ${control.pass}/${control.pass + control.fail}. Unavailable: ${control.unavailable}.\n\nThe seeded control preserves the observed weak selection count and keeps verdict fallbacks strong. It uses independent baseline outcomes, not fresh routed coding runs.\n`);
  return { directory, replay };
}

function configurationWithoutThreshold(config: LabConfig): FrozenPolicy["provenance"]["configurationWithoutThreshold"] {
  const { routing, ...rest } = structuredClone(config);
  const { weakThreshold: _, ...routingWithoutThreshold } = routing;
  return { ...rest, routing: routingWithoutThreshold };
}

export async function freezePolicy(
  experimentDirectory: string,
  threshold: number,
  createdAt = new Date().toISOString(),
  options?: { benchmarkProfile: "harness-v1"; roots: EvaluationRoots; priorExposure?: string[] },
): Promise<FrozenPolicy> {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Frozen threshold must be a finite number from 0 to 1");
  }
  const { manifest, trials } = await loadExperimentRecords(experimentDirectory);
  if (manifest.suite !== "dev") throw new Error("Policies can only be frozen from a dev experiment");
  if (trials.some(({ outcome }) => outcome === "incomplete")) {
    throw new Error("Cannot freeze policy from an incomplete development experiment");
  }
  if (options && trials.some(({ outcome }) => outcome !== "pass" && outcome !== "fail")) throw new Error("Benchmark freeze requires complete evaluated development trials");
  const benchmark = options ? await makeBenchmarkProtocol(manifest, threshold, options.roots, options.priorExposure) : undefined;
  const withoutId = {
    schemaVersion: benchmark ? 2 as const : 1 as const,
    ...(benchmark ? { benchmark } : {}),
    createdAt,
    threshold,
    development: {
      experimentId: manifest.experimentId,
      manifestHash: manifest.manifestHash,
      sourceHash: developmentSourceHash(manifest, trials),
      evidenceKind: manifest.evidenceKind,
      corpusRevision: hash(
        manifest.tasks.map(({ id, taskHash, sourceHash, validatorHash }) => ({
          id,
          taskHash,
          sourceHash,
          validatorHash,
        })),
      ),
    },
    provenance: {
      authProfile: manifest.authProfile,
      capabilityCardHash: manifest.fingerprints.capabilityCardHash,
      modelMetadataHash: manifest.fingerprints.modelMetadataHash,
      providerConfigHash: manifest.fingerprints.providerConfigHash,
      roles: structuredClone(manifest.roles),
      configurationWithoutThreshold: configurationWithoutThreshold(manifest.configuration),
    },
  };
  const policy: FrozenPolicy = { ...withoutId, policyId: hash(withoutId) };
  const path = join(experimentDirectory, "policy.json");
  if (await exists(path)) {
    const existing = validateFrozenPolicy(JSON.parse(await readFile(path, "utf8")));
    const { policyId: existingId, createdAt: existingCreated, ...existingComparable } = existing;
    const { policyId: nextId, createdAt: nextCreated, ...nextComparable } = policy;
    void existingId;
    void existingCreated;
    void nextId;
    void nextCreated;
    if (JSON.stringify(existingComparable) !== JSON.stringify(nextComparable)) {
      throw new Error("Frozen policy is immutable; use a new development experiment");
    }
    return existing;
  }
  await durableWrite(path, `${JSON.stringify(policy, null, 2)}\n`);
  return policy;
}

export function validateFrozenPolicy(value: unknown): FrozenPolicy {
  if (typeof value !== "object" || value === null) throw new Error("Policy must be an object");
  const policy = structuredClone(value) as FrozenPolicy;
  const exactKeys = (entry: unknown, keys: readonly string[], label: string) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([...keys].sort())
    ) {
      throw new Error(`${label} has unexpected or missing fields`);
    }
  };
  exactKeys(policy, [
    "schemaVersion", "policyId", "createdAt", "threshold", "development", "provenance",
    ...(policy.schemaVersion === 2 ? ["benchmark"] : []),
  ], "Policy");
  exactKeys(policy.development, [
    "experimentId", "manifestHash", "sourceHash", "evidenceKind", "corpusRevision",
  ], "Policy development provenance");
  exactKeys(policy.provenance, [
    "authProfile", "capabilityCardHash", "modelMetadataHash", "providerConfigHash", "roles",
    "configurationWithoutThreshold",
  ], "Policy runtime provenance");
  if (
    ![1, 2].includes(policy.schemaVersion) ||
    typeof policy.policyId !== "string" ||
    !/^[0-9a-f]{64}$/.test(policy.policyId) ||
    !Number.isFinite(policy.threshold) ||
    policy.threshold < 0 ||
    policy.threshold > 1 ||
    !policy.development ||
    typeof policy.development.experimentId !== "string" ||
    !/^[0-9a-f]{64}$/.test(policy.development.manifestHash) ||
    !/^[0-9a-f]{64}$/.test(policy.development.sourceHash) ||
    !/^[0-9a-f]{64}$/.test(policy.development.corpusRevision) ||
    !["mock", "live"].includes(policy.development.evidenceKind) ||
    !policy.provenance ||
    typeof policy.provenance.authProfile !== "string" ||
    !/^[0-9a-f]{64}$/.test(policy.provenance.capabilityCardHash) ||
    !/^[0-9a-f]{64}$/.test(policy.provenance.modelMetadataHash) ||
    !/^[0-9a-f]{64}$/.test(policy.provenance.providerConfigHash) ||
    typeof policy.createdAt !== "string" ||
    Number.isNaN(Date.parse(policy.createdAt))
  ) {
    throw new Error("Frozen policy is invalid");
  }
  validateConfig({
    ...policy.provenance.configurationWithoutThreshold,
    routing: {
      ...policy.provenance.configurationWithoutThreshold.routing,
      weakThreshold: policy.threshold,
    },
  });
  if (policy.schemaVersion === 2) {
    const protocol = validateBenchmarkProtocol(policy.benchmark);
    if (protocol.evidenceKind !== policy.development.evidenceKind || protocol.configuration.routing.weakThreshold !== policy.threshold || JSON.stringify(configurationWithoutThreshold(protocol.configuration)) !== JSON.stringify(policy.provenance.configurationWithoutThreshold)) throw new Error("Frozen policy and benchmark disagree");
  }
  const { policyId, ...withoutId } = policy;
  if (hash(withoutId) !== policyId) throw new Error("Frozen policy hash mismatch");
  return policy;
}

export async function verifyHeldoutPolicy(options: {
  policyPath: string;
  configPath: string;
  configCheckPath: string;
}): Promise<FrozenPolicy> {
  const policy = validateFrozenPolicy(JSON.parse(await readFile(options.policyPath, "utf8")));
  const config = validateConfig(JSON.parse(await readFile(options.configPath, "utf8")));
  const checked = JSON.parse(await readFile(options.configCheckPath, "utf8")) as {
    authProfile?: unknown;
    fingerprint?: Record<string, unknown>;
    roles?: unknown;
  };
  if (
    config.routing.weakThreshold !== policy.threshold ||
    JSON.stringify(configurationWithoutThreshold(config)) !==
      JSON.stringify(policy.provenance.configurationWithoutThreshold) ||
    config.authProfile !== policy.provenance.authProfile ||
    JSON.stringify(config.models) !== JSON.stringify(policy.provenance.roles) ||
    checked.authProfile !== policy.provenance.authProfile ||
    checked.fingerprint?.capabilityCardHash !== policy.provenance.capabilityCardHash ||
    checked.fingerprint?.modelMetadataHash !== policy.provenance.modelMetadataHash ||
    checked.fingerprint?.providerConfigHash !== policy.provenance.providerConfigHash
  ) {
    throw new Error("Held-out policy fingerprint, profile, roles, or threshold changed");
  }
  return policy;
}

export function randomSelectionReplay(manifest: SmokeManifest, trials: readonly ResolvedTrial[]) {
  if (manifest.suite !== "dev") throw new Error("Random selection replay is development-only");
  const groups = new Map<string, Partial<Record<EvaluationMode, ResolvedTrial>>>();
  for (const trial of trials) { const key = `${trial.taskId}:${trial.repetition}`; const group = groups.get(key) ?? {}; group[trial.mode] = trial; groups.set(key, group); }
  const rows = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([,group]) => group);
  const normal = rows.map((row,index)=>({ row,index })).filter(({row})=>row.routed?.result?.decision?.source === "classifier" && row.routed.result.decision.weakSolveProbability !== null);
  const weakSelections = normal.filter(({row})=>row.routed!.result!.decision!.selectedTier === "weak").length;
  const random = mulberry32(manifest.seed); const shuffled = [...normal];
  for (let i=shuffled.length-1;i>0;i--) { const j=Math.floor(random()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j]!,shuffled[i]!]; }
  const selectedWeak = new Set(shuffled.slice(0,weakSelections).map(({index})=>index));
  let pass=0,fail=0,unavailable=0,recordedDecisions=0;
  const selections = rows.map((row,index)=>{const decision=row.routed?.result?.decision; if(!decision){unavailable++;return {taskId:row.routed?.taskId??row["weak-only"]?.taskId??row["strong-only"]?.taskId,tier:null,outcome:"unavailable"};}recordedDecisions++;const tier=selectedWeak.has(index)?"weak":"strong";const baseline=row[tier==="weak"?"weak-only":"strong-only"];if(baseline?.outcome==="pass")pass++;else if(baseline?.outcome==="fail")fail++;else unavailable++;return {taskId:row.routed!.taskId,repetition:row.routed!.repetition,tier,outcome:baseline?.outcome??"unavailable"};});
  return {schemaVersion:1,evidenceKind:"replay",sourceEvidenceKind:manifest.evidenceKind,sourceManifestHash:manifest.manifestHash,seed:manifest.seed,weakSelections,recordedDecisions,pass,fail,unavailable,selections};
}
