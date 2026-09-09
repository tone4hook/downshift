import { createHash } from "node:crypto";

export const CORE_DEV = ["01-null-summary", "02-create-validation", "03-stable-filter", "04-page-boundaries", "05-safe-result-types", "06-money-total"] as const;
export const CORE_HELDOUT = ["07-tenant-authorization", "08-deduplicate-submit", "09-latest-search", "10-singleflight-cache", "11-retry-policy", "12-atomic-transfer", "13-import-diagnostics", "14-idempotent-events", "15-cancel-batch", "16-config-precedence", "17-subscription-lifecycle", "18-service-pagination"] as const;
export const HARNESS_DEV = ["19-cli-precedence", "20-contract-upgrade", "21-project-membership", "22-cache-invalidation", "23-worker-drain", "24-checkout-rollback", "25-stream-disposal", "26-import-pipeline"] as const;
export const HARNESS_HELDOUT = ["27-profile-migration", "28-release-arguments", "29-cursor-contract", "30-error-contract", "31-shared-link-access", "32-bulk-authorization", "33-negative-cache", "34-cache-refresh-race", "35-retry-worker", "36-bounded-dispatch", "37-inventory-reservation", "38-event-outbox", "39-abort-listeners", "40-resource-stack", "41-archive-import", "42-export-pagination"] as const;
export const ALL_TASK_IDS = [...CORE_DEV, ...CORE_HELDOUT, ...HARNESS_DEV, ...HARNESS_HELDOUT] as const;
export type TaskId = typeof ALL_TASK_IDS[number];
export type CorpusId = "core" | "harness" | "combined";
export interface CorpusDefinition {
  schemaVersion: 1;
  id: CorpusId;
  tasks: Array<{ id: TaskId; split: "dev" | "heldout"; clusterId: string; corpus: "core" | "harness"; weight: 1 }>;
}

export function corpusDefinition(id: CorpusId = "core"): CorpusDefinition {
  if (!["core", "harness", "combined"].includes(id)) throw new Error(`Unknown corpus: ${id}`);
  const tasks = ALL_TASK_IDS.filter((task) => id === "combined" || (id === "core") === [...CORE_DEV, ...CORE_HELDOUT].includes(task as typeof CORE_DEV[number])).map((task) => ({
    id: task,
    split: [...CORE_DEV, ...HARNESS_DEV].includes(task as typeof CORE_DEV[number]) ? "dev" as const : "heldout" as const,
    // Every fixture is independently authored. Any future derived fixture must reuse its parent's cluster and split.
    clusterId: task,
    corpus: ([...CORE_DEV, ...CORE_HELDOUT] as readonly string[]).includes(task) ? "core" as const : "harness" as const,
    weight: 1 as const,
  }));
  return { schemaVersion: 1, id, tasks };
}

export function corpusHash(corpus: CorpusDefinition): string {
  return createHash("sha256").update(JSON.stringify(corpus)).digest("hex");
}

export function corpusTasks(id: CorpusId, suite: "smoke" | "dev" | "heldout" | "full"): TaskId[] {
  const tasks = corpusDefinition(id).tasks;
  if (suite === "full") return tasks.map((task) => task.id);
  const selected = tasks.filter((task) => task.split === (suite === "heldout" ? "heldout" : "dev"));
  return (suite === "smoke" ? selected.slice(0, 3) : selected).map((task) => task.id);
}

export function routingWordings(prompt: string): [string, string, string] {
  return [prompt, `Requested code change:\n${prompt}\nDeliver the implementation of these requirements.`, `The following describes the required behavior after this change:\n\n${prompt}\n\nUpdate the project to provide that behavior.`];
}
