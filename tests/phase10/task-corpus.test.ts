import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../../src/config/lab-config.js";
import {
  DEVELOPMENT_TASK_IDS,
  FULL_TASK_IDS,
  HELDOUT_TASK_IDS,
  SMOKE_TASK_IDS,
  createEvaluationPlan,
} from "../../src/evaluation/smoke.js";
import { loadTaskDefinition, type EvaluationRoots } from "../../src/evaluation/task.js";
import { verifyReference } from "../../src/evaluation/validator.js";

const roots: EvaluationRoots = {
  tasksRoot: resolve("tasks"),
  fixturesRoot: resolve("fixtures"),
  evaluatorRoot: resolve("evaluator"),
};
const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0).reverse()) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("Phase 10 task corpus", () => {
  it("freezes unique, non-overlapping suite membership", () => {
    expect(SMOKE_TASK_IDS).toEqual([
      "01-null-summary",
      "02-create-validation",
      "03-stable-filter",
    ]);
    expect(DEVELOPMENT_TASK_IDS).toEqual([
      "01-null-summary",
      "02-create-validation",
      "03-stable-filter",
      "04-page-boundaries",
      "05-safe-result-types",
      "06-money-total",
    ]);
    expect(new Set(DEVELOPMENT_TASK_IDS).size).toBe(6);
    expect(HELDOUT_TASK_IDS).toEqual([
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
    ]);
    expect(FULL_TASK_IDS).toEqual([...DEVELOPMENT_TASK_IDS, ...HELDOUT_TASK_IDS]);
    expect(new Set(FULL_TASK_IDS).size).toBe(18);
  });

  it(
    "verifies eighteen intended baseline failures, reference passes, and negative rejections",
    async () => {
      const output = await mkdtemp(join(tmpdir(), "routing-lab-phase10-dev-"));
      cleanup.push(output);
      for (const id of FULL_TASK_IDS) {
        const task = await loadTaskDefinition(id, roots);
        expect(task.definition.split).toBe(
          DEVELOPMENT_TASK_IDS.includes(id as (typeof DEVELOPMENT_TASK_IDS)[number])
            ? "dev"
            : "heldout",
        );
        const result = await verifyReference(task, join(output, id));
        expect(result.baseline.status).toBe("fail");
        expect(result.reference.status).toBe("pass");
        expect(result.incomplete.status).toBe("fail");
      }
    },
    90_000,
  );

  it("plans each fixed suite with the documented default repetition counts", async () => {
    const config = validateConfig({
      schemaVersion: 1,
      authProfile: "mock",
      models: {
        classifier: { provider: "mock", model: "classifier", billing: "unknown" },
        weak: { provider: "mock", model: "weak", billing: "unknown" },
        strong: { provider: "mock", model: "strong", billing: "unknown" },
      },
      routing: {
        weakThreshold: 0.75,
        weakCapabilityDescription: "Mock weak model.",
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
    expect(createEvaluationPlan(config, {
      suite: "dev",
      repetitions: 3,
      seed: 20260905,
    })).toMatchObject({
      available: true,
      taskCount: 6,
      codingTrials: 54,
      expectedClassifierCalls: 18,
    });
    expect(createEvaluationPlan(config, {
      suite: "heldout",
      repetitions: 3,
      seed: 20260905,
    })).toMatchObject({
      available: true,
      taskCount: 12,
      codingTrials: 108,
      expectedClassifierCalls: 36,
    });
    expect(createEvaluationPlan(config, {
      suite: "full",
      repetitions: 3,
      seed: 20260905,
    })).toMatchObject({
      available: true,
      taskCount: 18,
      codingTrials: 162,
      expectedClassifierCalls: 54,
    });
  });
});
