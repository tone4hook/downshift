import type { Usage } from "@earendil-works/pi-ai";
import type { LabModelRole, ModelPricing } from "../config/lab-config.js";

export type UsageRole = "classifier" | "coding" | "compaction";

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number | null;
  totalTokens: number;
  semantics: "pi-exclusive-categories";
}

export interface UsageSummary {
  status: "complete" | "partial" | "unknown";
  observedCalls: number;
  missingCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  semantics: "pi-exclusive-categories";
  missingReasons: string[];
}

export interface RoleCost {
  billing: LabModelRole["billing"];
  currency: "USD" | null;
  pricingAsOf: string | null;
  estimatedCostUsd: number | null;
  referenceCostUsd: number | null;
  missingReasons: string[];
}

interface RecordedUsage {
  role: UsageRole;
  usage: NormalizedUsage | null;
  complete: boolean;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid provider usage: ${name} must be a nonnegative safe integer`);
  }
  return value;
}

export function normalizeUsage(usage: Usage): NormalizedUsage {
  const normalized: NormalizedUsage = {
    inputTokens: nonnegativeInteger(usage.input, "input"),
    outputTokens: nonnegativeInteger(usage.output, "output"),
    cacheReadTokens: nonnegativeInteger(usage.cacheRead, "cacheRead"),
    cacheWriteTokens: nonnegativeInteger(usage.cacheWrite, "cacheWrite"),
    reasoningTokens:
      usage.reasoning === undefined ? null : nonnegativeInteger(usage.reasoning, "reasoning"),
    totalTokens: nonnegativeInteger(usage.totalTokens, "totalTokens"),
    semantics: "pi-exclusive-categories",
  };
  const computed =
    normalized.inputTokens +
    normalized.outputTokens +
    normalized.cacheReadTokens +
    normalized.cacheWriteTokens;
  if (computed !== normalized.totalTokens) {
    throw new Error(
      `Invalid provider usage: totalTokens=${normalized.totalTokens} does not match Pi category total ${computed}`,
    );
  }
  if (
    normalized.reasoningTokens !== null &&
    normalized.reasoningTokens > normalized.outputTokens
  ) {
    throw new Error("Invalid provider usage: reasoning tokens exceed output tokens");
  }
  return normalized;
}

function summarize(records: readonly RecordedUsage[]): UsageSummary {
  // No dispatched calls is an observed zero. A dispatched call without usage below is unknown.
  if (records.length === 0) return {
    status: "complete", observedCalls: 0, missingCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, semantics: "pi-exclusive-categories", missingReasons: [],
  };
  const observed = records.filter(
    (record): record is RecordedUsage & { usage: NormalizedUsage } => record.usage !== null,
  );
  const missingCalls = records.length - observed.length;
  const incompleteCalls = observed.filter((record) => !record.complete).length;
  if (observed.length === 0) {
    return {
      status: "unknown",
      observedCalls: 0,
      missingCalls,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      semantics: "pi-exclusive-categories",
      missingReasons: [
        records.length === 0
          ? "no provider calls were observed for this usage group"
          : "provider usage was absent for every observed call",
      ],
    };
  }
  const sum = (field: keyof Pick<
    NormalizedUsage,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens"
  >) => observed.reduce((total, record) => total + record.usage[field], 0);
  const reasoningComplete = observed.every((record) => record.usage.reasoningTokens !== null);
  return {
    status: missingCalls === 0 && incompleteCalls === 0 ? "complete" : "partial",
    observedCalls: observed.length,
    missingCalls,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"),
    reasoningTokens: reasoningComplete
      ? observed.reduce((total, record) => total + record.usage.reasoningTokens!, 0)
      : null,
    totalTokens: sum("totalTokens"),
    semantics: "pi-exclusive-categories",
    missingReasons: [
      ...(missingCalls > 0 ? [`provider usage was absent for ${missingCalls} observed call(s)`] : []),
      ...(incompleteCalls > 0
        ? [`${incompleteCalls} observed call(s) ended before complete usage was confirmed`]
        : []),
      ...(!reasoningComplete ? ["provider reasoning-token breakdown was not reported"] : []),
    ],
  };
}

export class UsageLedger {
  private readonly calls = new Map<string, RecordedUsage>();

  record(
    callId: string,
    role: UsageRole,
    usage: NormalizedUsage | null,
    complete = true,
  ): boolean {
    if (!callId) throw new Error("Usage call ID must not be empty");
    const next = { role, usage, complete };
    const existing = this.calls.get(callId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(next)) {
        throw new Error(`Conflicting duplicate usage for provider call ${callId}`);
      }
      return false;
    }
    this.calls.set(callId, next);
    return true;
  }

  summaries(): Record<UsageRole | "total", UsageSummary> {
    const byRole = (role: UsageRole) =>
      summarize([...this.calls.values()].filter((record) => record.role === role));
    return {
      classifier: byRole("classifier"),
      coding: byRole("coding"),
      compaction: byRole("compaction"),
      total: summarize([...this.calls.values()]),
    };
  }

  summaryForRoles(roles: readonly UsageRole[]): UsageSummary {
    const selected = new Set(roles);
    return summarize([...this.calls.values()].filter((record) => selected.has(record.role)));
  }
}

function calculateWithPricing(
  usage: UsageSummary,
  pricing: ModelPricing | { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number; cacheWritePerMillion?: number },
): number | null {
  if (usage.observedCalls === 0 && usage.missingCalls === 0) return 0;
  if (
    usage.status !== "complete" ||
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    usage.cacheReadTokens === null ||
    usage.cacheWriteTokens === null
  ) {
    return null;
  }
  if (usage.cacheReadTokens > 0 && pricing.cacheReadPerMillion === undefined) return null;
  if (usage.cacheWriteTokens > 0 && pricing.cacheWritePerMillion === undefined) return null;
  return (
    usage.inputTokens * pricing.inputPerMillion +
    usage.outputTokens * pricing.outputPerMillion +
    usage.cacheReadTokens * (pricing.cacheReadPerMillion ?? 0) +
    usage.cacheWriteTokens * (pricing.cacheWritePerMillion ?? 0)
  ) / 1_000_000;
}

export function calculateRoleCost(
  role: LabModelRole,
  usage: UsageSummary,
  referencePricing?: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
  },
): RoleCost {
  const estimatedCostUsd =
    role.billing === "per-token" && role.pricing
      ? calculateWithPricing(usage, role.pricing)
      : null;
  const referenceCostUsd = referencePricing
    ? calculateWithPricing(usage, referencePricing)
    : null;
  return {
    billing: role.billing,
    currency: role.billing === "per-token" ? "USD" : null,
    pricingAsOf: role.billing === "per-token" ? role.pricing?.asOf ?? null : null,
    estimatedCostUsd,
    referenceCostUsd,
    missingReasons: [
      ...(role.billing !== "per-token"
        ? [`estimated cost is unavailable for ${role.billing} billing`]
        : estimatedCostUsd === null
          ? ["estimated cost is unavailable because usage or cache pricing is incomplete"]
          : []),
      ...(referencePricing && referenceCostUsd === null
        ? ["reference cost is unavailable because usage or cache pricing is incomplete"]
        : []),
      ...(!referencePricing ? ["Pi reference pricing is unavailable"] : []),
    ],
  };
}
