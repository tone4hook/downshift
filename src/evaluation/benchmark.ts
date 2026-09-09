import { corpusDefinition, corpusHash, type CorpusDefinition, type CorpusId } from "./corpus.js";
import { digest, exactKeys } from "./records.js";
import { loadTaskDefinition, type EvaluationRoots } from "./task.js";
import { validateConfig, type LabConfig } from "../config/lab-config.js";
import type { SmokeManifest } from "./smoke.js";

export const READINESS_METHOD = { resamples: 10000, lowerQuantile: 0.025, upperQuantile: 0.975, minimumClusters: 20, minimumValidResamples: 5000, weighting: "equal-task" } as const;
export const READINESS_TARGETS = { absoluteSuccess: 0.8, qualityDifference: -0.05, strongTokenReduction: 0.25 } as const;
export interface BenchmarkProtocol {
  schemaVersion: 1;
  protocolId: string;
  profile: "harness-v1";
  evidenceKind: "mock" | "live";
  corpus: CorpusDefinition;
  corpusHash: string;
  tasks: Array<{ id: string; taskHash: string; sourceHash: string; validatorHash: string }>;
  sourceContentHash: string;
  images: { agent: string; evaluator: string };
  configuration: LabConfig;
  seed: number;
  repetitions: 5;
  maxCostUsd: number | null;
  suite: "heldout";
  method: typeof READINESS_METHOD;
  targets: typeof READINESS_TARGETS;
  priorExposure: string[];
}

export async function makeBenchmarkProtocol(manifest: SmokeManifest, threshold: number, roots: EvaluationRoots, priorExposure: string[] = []): Promise<BenchmarkProtocol> {
  if (manifest.schemaVersion !== 2 || manifest.corpus?.id !== "combined" || !manifest.sourceContentHash || manifest.suite !== "dev") throw new Error("harness-v1 requires a version 2 combined development experiment");
  const corpus = corpusDefinition("combined");
  const tasks = await Promise.all(corpus.tasks.filter((task) => task.split === "heldout").map(async ({ id }) => {
    const task = await loadTaskDefinition(id, roots);
    return { id, taskHash: task.taskHash, sourceHash: task.definition.fixture.hash, validatorHash: task.definition.validatorHash };
  }));
  const configuration = structuredClone(manifest.configuration);
  configuration.routing.weakThreshold = threshold;
  const value = {
    schemaVersion: 1 as const, profile: "harness-v1" as const, evidenceKind: manifest.evidenceKind,
    corpus, corpusHash: corpusHash(corpus), tasks, sourceContentHash: manifest.sourceContentHash,
    images: { agent: manifest.images.agent, evaluator: manifest.images.evaluator }, configuration,
    seed: manifest.seed, repetitions: 5 as const, maxCostUsd: manifest.maxCostUsd, suite: "heldout" as const,
    method: READINESS_METHOD, targets: READINESS_TARGETS, priorExposure,
  };
  return validateBenchmarkProtocol({ ...value, protocolId: digest(value) });
}

export function validateBenchmarkProtocol(value: unknown): BenchmarkProtocol {
  exactKeys(value, ["schemaVersion", "protocolId", "profile", "evidenceKind", "corpus", "corpusHash", "tasks", "sourceContentHash", "images", "configuration", "seed", "repetitions", "maxCostUsd", "suite", "method", "targets", "priorExposure"], "Benchmark protocol");
  const p = structuredClone(value) as unknown as BenchmarkProtocol;
  const { protocolId, ...withoutId } = p;
  if (p.schemaVersion !== 1 || p.profile !== "harness-v1" || !["live", "mock"].includes(p.evidenceKind) || p.suite !== "heldout" || p.repetitions !== 5 || !Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff || protocolId !== digest(withoutId)) throw new Error("Invalid benchmark protocol identity or schedule");
  if (JSON.stringify(p.corpus) !== JSON.stringify(corpusDefinition("combined")) || p.corpusHash !== corpusHash(p.corpus) || JSON.stringify(p.method) !== JSON.stringify(READINESS_METHOD) || JSON.stringify(p.targets) !== JSON.stringify(READINESS_TARGETS)) throw new Error("Benchmark corpus, targets, or method changed");
  if (!/^[a-f0-9]{64}$/.test(p.sourceContentHash) || !Array.isArray(p.priorExposure) || p.priorExposure.some((v) => typeof v !== "string" || !v.trim())) throw new Error("Invalid source hash or prior exposure declaration");
  exactKeys(p.images, ["agent", "evaluator"], "Benchmark images");
  if (Object.values(p.images).some((v) => !/^sha256:[a-f0-9]{64}$/.test(v))) throw new Error("Benchmark requires immutable Docker image identities");
  const ids = p.corpus.tasks.filter((t) => t.split === "heldout").map((t) => t.id);
  if (!Array.isArray(p.tasks) || p.tasks.length !== ids.length) throw new Error("Benchmark task list mismatch");
  p.tasks.forEach((task, i) => {
    exactKeys(task, ["id", "taskHash", "sourceHash", "validatorHash"], "Benchmark task");
    if (task.id !== ids[i] || [task.taskHash, task.sourceHash, task.validatorHash].some((v) => !/^[a-f0-9]{64}$/.test(v))) throw new Error("Benchmark task identity mismatch");
  });
  if (p.maxCostUsd !== null && (!Number.isFinite(p.maxCostUsd) || p.maxCostUsd <= 0)) throw new Error("Invalid frozen monetary limit");
  validateConfig(p.configuration);
  return p;
}

export async function verifyBenchmarkExecution(p: BenchmarkProtocol, options: {
  corpus: CorpusId; suite: string; repetitions: number; maxCostUsd?: number | null; seed: number; evidenceKind: "mock" | "live";
  sourceContentHash: string; images: { agent: string; evaluator: string }; configuration: LabConfig; roots: EvaluationRoots;
}): Promise<void> {
  validateBenchmarkProtocol(p);
  if (options.corpus !== p.corpus.id || options.suite !== p.suite || options.repetitions !== p.repetitions || (options.maxCostUsd ?? null) !== p.maxCostUsd || options.seed !== p.seed || options.evidenceKind !== p.evidenceKind || options.sourceContentHash !== p.sourceContentHash || JSON.stringify(options.configuration) !== JSON.stringify(p.configuration) || options.images.agent !== p.images.agent || options.images.evaluator !== p.images.evaluator) throw new Error("Frozen benchmark configuration, source, images, corpus, or schedule changed");
  for (const expected of p.tasks) {
    const task = await loadTaskDefinition(expected.id, options.roots);
    if (task.taskHash !== expected.taskHash || task.definition.fixture.hash !== expected.sourceHash || task.definition.validatorHash !== expected.validatorHash) throw new Error(`Frozen benchmark task changed: ${expected.id}`);
  }
}
