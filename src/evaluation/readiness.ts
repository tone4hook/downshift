import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aggregateExperiment, loadExperimentRecords, type ResolvedTrial, type Interval } from "./analysis.js";
import { validateBenchmarkProtocol, READINESS_METHOD, READINESS_TARGETS } from "./benchmark.js";
import { mulberry32, type SmokeManifest } from "./smoke.js";
import { atomicJson, digest, readJson, exactKeys, markdown } from "./records.js";
import { validateVerificationReport, type VerificationReport } from "./verification.js";

export type ReadinessVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";
export interface ReadinessMetric { value: number | null; interval: Interval | null; target: number; validResamples: number; reason: string | null; }
export interface ReadinessReport {
  schemaVersion: 1;
  reportHash: string;
  experimentId: string;
  manifestHash: string;
  protocolId: string | null;
  verificationHash: string;
  evidenceKind: "mock" | "live";
  verdict: ReadinessVerdict;
  engineering: "PASS" | "FAIL" | "INCONCLUSIVE";
  reasons: string[];
  planned: number;
  evaluated: number;
  independentClusters: number;
  completeUsage: boolean;
  metrics: { absoluteSuccess: ReadinessMetric; qualityDifference: ReadinessMetric; strongTokenReduction: ReadinessMetric };
  strata: Array<{ corpus: string; planned: number; evaluated: number; routedSuccess: number | null; qualityDifference: number | null }>;
  limitations: string[];
}
export interface AssessmentRow { taskId: string; clusterId: string; routed: number; strong: number; routedStrongTokens: number | null; baselineStrongTokens: number | null; }

/** Includes classifier, coding, and compaction on this exact native identity across every attempt. */
export function strongIdentityTokens(trial: ResolvedTrial, identity: { provider: string; model: string }): number | null {
  if (trial.incompletePhysicalAttempts || !trial.physicalAttempts.length) return null;
  let total = 0;
  for (const run of trial.physicalAttempts) {
    for (const role of ["classifier", "coding", "compaction"] as const) {
      const usage = run.usage[role];
      // Missing usage remains unknown even when an interrupted request has no observable identity.
      if (usage.status !== "complete" || usage.missingCalls > 0 || usage.totalTokens === null) return null;
      if (usage.observedCalls === 0) continue;
      const tier = run.decision?.selectedTier ?? (run.mode === "weak-only" ? "weak" : run.mode === "strong-only" ? "strong" : null);
      const model = role === "classifier" ? run.provenance.models.classifier : tier ? run.provenance.models[tier] : null;
      if (!model) return null;
      if (role !== "classifier" && (run.servedModel?.provider !== model.provider || run.servedModel.model !== model.model)) return null;
      if (model.provider === identity.provider && model.model === identity.model) total += usage.totalTokens;
    }
  }
  return total;
}
function means(rows: readonly AssessmentRow[]): [number | null, number | null, number | null] {
  if (!rows.length) return [null, null, null];
  const byTask = new Map<string, AssessmentRow[]>();
  for (const row of rows) { const group = byTask.get(row.taskId) ?? []; group.push(row); byTask.set(row.taskId, group); }
  const tasks = [...byTask.values()];
  const success = tasks.reduce((n, rs) => n + rs.reduce((v, r) => v + r.routed, 0) / rs.length, 0) / tasks.length;
  const quality = tasks.reduce((n, rs) => n + rs.reduce((v, r) => v + r.routed - r.strong, 0) / rs.length, 0) / tasks.length;
  if (rows.some((r) => r.routedStrongTokens === null || r.baselineStrongTokens === null)) return [success, quality, null];
  const routed = tasks.reduce((n, rs) => n + rs.reduce((v, r) => v + r.routedStrongTokens!, 0) / rs.length, 0);
  const strong = tasks.reduce((n, rs) => n + rs.reduce((v, r) => v + r.baselineStrongTokens!, 0) / rs.length, 0);
  return [success, quality, strong > 0 ? 1 - routed / strong : null];
}

export function readinessMetrics(rows: readonly AssessmentRow[], seed: number): ReadinessReport["metrics"] {
  const ids = [...new Set(rows.map((r) => r.clusterId))].sort();
  const grouped = new Map(ids.map((id) => [id, rows.filter((r) => r.clusterId === id)]));
  const values = means(rows);
  const samples: number[][] = [[], [], []];
  if (ids.length >= READINESS_METHOD.minimumClusters) {
    const random = mulberry32(seed);
    for (let b = 0; b < READINESS_METHOD.resamples; b++) {
      const selected: AssessmentRow[] = [];
      for (let draw = 0; draw < ids.length; draw++) {
        const group = grouped.get(ids[Math.floor(random() * ids.length)]!)!;
        // A resampled cluster is a new copy, not a duplicate collapsed by task ID.
        selected.push(...group.map((row) => ({ ...row, taskId: `${draw}:${row.taskId}` })));
      }
      means(selected).forEach((value, i) => { if (value !== null && Number.isFinite(value)) samples[i]!.push(value); });
    }
  }
  return Object.fromEntries((Object.keys(READINESS_TARGETS) as Array<keyof typeof READINESS_TARGETS>).map((key, i) => {
    const observed = values[i]!;
    const sorted = samples[i]!.sort((a, b) => a - b);
    let reason: string | null = observed === null ? "Missing usage or undefined denominator" : ids.length < READINESS_METHOD.minimumClusters ? "Fewer than twenty independent held-out clusters" : sorted.length < READINESS_METHOD.minimumValidResamples ? "Insufficient valid bootstrap resamples" : sorted.at(-1)! - sorted[0]! < 1e-12 ? "Degenerate bootstrap distribution; zero-width certainty is unsupported" : null;
    const interval = reason ? null : { lower: sorted[Math.floor((sorted.length - 1) * 0.025)]!, upper: sorted[Math.ceil((sorted.length - 1) * 0.975)]! };
    if (interval && interval.upper - interval.lower < 1e-12) reason = "Sparse bootstrap distribution; percentile bounds have collapsed";
    return [key, { value: observed, interval: reason ? null : interval, target: READINESS_TARGETS[key], validResamples: sorted.length, reason }];
  })) as ReadinessReport["metrics"];
}

export function assessReadiness(manifest: SmokeManifest, trials: readonly ResolvedTrial[], verification: VerificationReport): ReadinessReport {
  validateVerificationReport(verification);
  const reasons: string[] = [];
  const protocol = manifest.benchmark ? validateBenchmarkProtocol(manifest.benchmark) : null;
  const matches = manifest.sourceContentHash === verification.sourceContentHash && manifest.images.agent === verification.images.agent && manifest.images.evaluator === verification.images.evaluator;
  const engineering: ReadinessVerdict = !matches ? "INCONCLUSIVE" : verification.status === "FAIL" ? "FAIL" : verification.level === "full" && verification.status === "PASS" ? "PASS" : "INCONCLUSIVE";
  if (!matches) reasons.push("Verification source or images do not match this experiment");
  if (engineering !== "PASS") reasons.push("Full matching engineering verification has not passed");
  if (!protocol || manifest.suite !== "heldout") reasons.push("Only a predeclared version 2 held-out benchmark can establish readiness");
  if (manifest.evidenceKind !== "live") reasons.push("Mock evidence cannot establish live routing capability");
  if (protocol?.priorExposure.length) reasons.push("Prior exposure is declared; these held-out outcomes are descriptive, not fresh confirmation");
  const groups = new Map<string, Partial<Record<"weak-only" | "strong-only" | "routed", ResolvedTrial>>>();
  for (const trial of trials) {
    const key = `${trial.taskId}:${trial.repetition}`;
    const group = groups.get(key) ?? {};
    if (group[trial.mode]) throw new Error(`Duplicate assessment trial: ${trial.trialId}`);
    group[trial.mode] = trial; groups.set(key, group);
  }
  const rows: AssessmentRow[] = [];
  const isEvaluated = (t: ResolvedTrial | undefined): t is ResolvedTrial => !!t && ["pass", "fail"].includes(t.outcome);
  for (const group of groups.values()) {
    const r = group.routed, s = group["strong-only"];
    if (!isEvaluated(r) || !isEvaluated(s)) continue;
    rows.push({ taskId: r.taskId, clusterId: manifest.corpus?.tasks.find((t) => t.id === r.taskId)?.clusterId ?? r.taskId, routed: Number(r.outcome === "pass"), strong: Number(s.outcome === "pass"), routedStrongTokens: strongIdentityTokens(r, manifest.roles.strong), baselineStrongTokens: strongIdentityTokens(s, manifest.roles.strong) });
  }
  const evaluated = trials.filter(isEvaluated).length;
  const complete = evaluated === manifest.schedule.length && trials.length === manifest.schedule.length;
  const completeUsage = complete && trials.every((t) => strongIdentityTokens(t, manifest.roles.strong) !== null);
  if (!complete) reasons.push("The predeclared schedule contains incomplete or unavailable trials");
  if (!completeUsage) reasons.push("Usage is not complete across all physical attempts");
  const metrics = readinessMetrics(rows, protocol?.seed ?? manifest.seed);
  const metricValues = Object.values(metrics);
  for (const metric of metricValues) if (metric.reason) reasons.push(metric.reason);
  const eligible = !!protocol && manifest.suite === "heldout" && manifest.evidenceKind === "live" && !protocol.priorExposure.length;
  let verdict: ReadinessVerdict = "INCONCLUSIVE";
  if (engineering === "FAIL") verdict = "FAIL";
  else if (eligible && complete && completeUsage && metricValues.some((m) => m.interval && m.interval.upper < m.target)) verdict = "FAIL";
  else if (eligible && complete && completeUsage && engineering === "PASS" && metricValues.every((m) => m.interval && m.interval.lower >= m.target)) verdict = "PASS";
  if (verdict === "INCONCLUSIVE" && !reasons.length) reasons.push("At least one confidence interval crosses its target");
  const strata = ["core", "harness"].map((corpus) => {
    const ids = new Set(manifest.corpus?.tasks.filter((t) => t.corpus === corpus).map((t) => t.id) ?? (corpus === "core" ? manifest.tasks.map((t) => t.id) : []));
    const selected = trials.filter((t) => ids.has(t.taskId));
    const [routedSuccess, qualityDifference] = means(rows.filter((r) => ids.has(r.taskId as typeof manifest.tasks[number]["id"])));
    return { corpus, planned: manifest.schedule.filter((t) => ids.has(t.taskId)).length, evaluated: selected.filter(isEvaluated).length, routedSuccess, qualityDifference };
  });
  const result = { schemaVersion: 1 as const, experimentId: manifest.experimentId, manifestHash: manifest.manifestHash, protocolId: protocol?.protocolId ?? null, verificationHash: verification.reportHash, evidenceKind: manifest.evidenceKind, verdict, engineering, reasons: [...new Set(reasons)], planned: manifest.schedule.length, evaluated, independentClusters: new Set(rows.map((r) => r.clusterId)).size, completeUsage, metrics, strata, limitations: ["Readiness applies only to the recorded model pair, classifier, task corpus, tools, and limits.", "Repeated attempts and prompt variants are not independent tasks; curated task coverage does not prove general coding-agent performance.", "Tokens on the exact strong provider/model identity include classifier, coding, compaction, and replacement attempts; token avoidance is not measured subscription quota or money.", "Latency, calibration, mistakes, fallback, operational completion, and individual task outcomes are in experiment.json and experiment.md."] };
  return { ...result, reportHash: digest(result) };
}
export function validateReadinessReport(value: unknown): ReadinessReport {
  exactKeys(value, ["schemaVersion", "reportHash", "experimentId", "manifestHash", "protocolId", "verificationHash", "evidenceKind", "verdict", "engineering", "reasons", "planned", "evaluated", "independentClusters", "completeUsage", "metrics", "strata", "limitations"], "Readiness report");
  const r = value as unknown as ReadinessReport; const { reportHash, ...rest } = r;
  if (r.schemaVersion !== 1 || reportHash !== digest(rest) || !["PASS", "FAIL", "INCONCLUSIVE"].includes(r.verdict)) throw new Error("Invalid readiness report");
  return structuredClone(r);
}
export function renderReadiness(report: ReadinessReport): string {
  return `# Harness readiness\n\n**${report.verdict}** · ${report.evidenceKind}\n\nEngineering: ${report.engineering}. Evaluated: ${report.evaluated}/${report.planned}. Independent clusters: ${report.independentClusters}.\n\n| Metric | Observed | 95% interval | Required lower bound |\n|---|---:|---|---:|\n${Object.entries(report.metrics).map(([name,m]) => `| ${name} | ${m.value === null ? "unknown" : (100*m.value).toFixed(2)+"%"} | ${m.interval ? `${(100*m.interval.lower).toFixed(2)}% to ${(100*m.interval.upper).toFixed(2)}%` : "unavailable"} | ${(100*m.target).toFixed(2)}% |`).join("\n")}\n\n| Corpus | Planned | Evaluated | Routed success | Quality difference |\n|---|---:|---:|---:|---:|\n${report.strata.map((s)=>`| ${s.corpus} | ${s.planned} | ${s.evaluated} | ${s.routedSuccess===null?"unknown":(100*s.routedSuccess).toFixed(2)+"%"} | ${s.qualityDifference===null?"unknown":(100*s.qualityDifference).toFixed(2)+" pp"} |`).join("\n")}\n\n${report.reasons.map((r)=>`- ${markdown(r)}`).join("\n")}\n\n${report.limitations.map((r)=>`- ${markdown(r)}`).join("\n")}\n\n[Full experiment report](experiment.md)\n`;
}
export async function generateReadiness(directory: string, verificationDirectory: string): Promise<ReadinessReport> {
  const { manifest, trials } = await loadExperimentRecords(directory);
  const verification = validateVerificationReport(await readJson(join(verificationDirectory, "verification.json")));
  for (const check of verification.checks) if (digest(await readFile(join(verificationDirectory, check.log), "utf8")) !== check.logHash) throw new Error("Verification log changed");
  if (manifest.benchmark && digest(await readJson(join(directory, "protocol.json"))) !== digest(manifest.benchmark)) throw new Error("Frozen protocol copy changed");
  // Run the same validated arithmetic used by the descriptive report before assessing.
  aggregateExperiment(manifest, trials);
  const report = assessReadiness(manifest, trials, verification);
  validateReadinessReport(report);
  await atomicJson(join(directory, "readiness.json"), report);
  await writeFile(join(directory, "readiness.md"), renderReadiness(report), { mode: 0o600 });
  return report;
}
