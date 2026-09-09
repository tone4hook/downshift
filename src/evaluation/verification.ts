import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, digest, exactKeys, markdown, readJson } from "./records.js";
import { loadExperimentRecords } from "./analysis.js";

export const QUICK_CHECKS = ["source-images", "contracts", "mock-smoke", "mock-ledger"] as const;
export const FULL_CHECKS = [...QUICK_CHECKS, "all-tests", "typecheck", "documentation", "fixtures", "host-integration"] as const;
export interface VerificationReport {
  schemaVersion: 1;
  reportHash: string;
  evidenceKind: "mock";
  verificationId: string;
  level: "quick" | "full";
  sourceContentHash: string;
  images: { agent: string; evaluator: string; mock: string };
  platform: string;
  createdAt: string;
  status: "PASS" | "FAIL" | "INCOMPLETE";
  checks: Array<{ id: string; objective: string; exitCode: number; expectedExitCode: number; status: "PASS" | "FAIL"; log: string; logHash: string }>;
  pendingPlatformGates: string[];
}
const OBJECTIVES: Record<string, string> = {
  "source-images": "Running images contain the current source and evaluation inputs",
  contracts: "Routing decisions, lifecycle, limits, isolation, accounting, and readiness arithmetic",
  "mock-smoke": "Every scheduled trial completes with the independently validated expected capability matrix",
  "mock-ledger": "Provider-side requests, identities, ordering, and usage agree with agent records",
  "all-tests": "All upstream, runtime, launcher, validator, scheduler, and analysis regressions",
  typecheck: "Strict TypeScript interfaces compile",
  documentation: "Public documentation, examples, and local links are valid",
  fixtures: "42 baselines fail, references pass, and curated partial implementations fail",
  "host-integration": "Clone-to-use, mount isolation, execution limits, interruption, cleanup, and resume",
};
function seal(value: Omit<VerificationReport, "reportHash">): VerificationReport { return { ...value, reportHash: digest(value) }; }
export function validateVerificationReport(value: unknown): VerificationReport {
  exactKeys(value, ["schemaVersion", "reportHash", "evidenceKind", "verificationId", "level", "sourceContentHash", "images", "platform", "createdAt", "status", "checks", "pendingPlatformGates"], "Verification report");
  const report = structuredClone(value) as unknown as VerificationReport;
  const { reportHash, ...rest } = report;
  if (report.schemaVersion !== 1 || reportHash !== digest(rest) || report.evidenceKind !== "mock" || !["quick", "full"].includes(report.level) || !/^[a-f0-9]{64}$/.test(report.sourceContentHash)) throw new Error("Invalid verification provenance");
  exactKeys(report.images, ["agent", "evaluator", "mock"], "Verification images");
  if (Object.values(report.images).some((v) => !/^sha256:[a-f0-9]{64}$/.test(v))) throw new Error("Invalid verification image identity");
  const required = report.level === "full" ? FULL_CHECKS : QUICK_CHECKS;
  if (!Array.isArray(report.checks) || new Set(report.checks.map((c) => c.id)).size !== report.checks.length) throw new Error("Duplicate verification checks");
  for (const check of report.checks) {
    exactKeys(check, ["id", "objective", "exitCode", "expectedExitCode", "status", "log", "logHash"], "Verification check");
    if (!(required as readonly string[]).includes(check.id) || check.objective !== OBJECTIVES[check.id] || !Number.isInteger(check.exitCode) || check.expectedExitCode !== (check.id === "mock-smoke" ? 1 : 0) || check.status !== (check.exitCode === check.expectedExitCode ? "PASS" : "FAIL") || check.log !== `${check.id}.log` || !/^[a-f0-9]{64}$/.test(check.logHash)) throw new Error("Invalid verification check");
  }
  const status = report.checks.some((c) => c.status === "FAIL") ? "FAIL" : report.checks.length === required.length ? "PASS" : "INCOMPLETE";
  if (report.status !== status) throw new Error("Verification status disagrees with required checks");
  return report;
}
async function save(directory: string, report: VerificationReport): Promise<void> {
  validateVerificationReport(report);
  await atomicJson(join(directory, "verification.json"), report);
  await writeFile(join(directory, "verification.md"), `# Engineering verification\n\n${report.status} · mock · ${report.level}\n\nSource: ${report.sourceContentHash}\n\n| Check | Objective | Result | Evidence |\n|---|---|---|---|\n${report.checks.map((c) => `| ${c.id} | ${markdown(c.objective)} | ${c.status} | [log](${c.log}) |`).join("\n")}\n\nPending operator gates: ${report.pendingPlatformGates.map(markdown).join("; ")}.\n\nMock verification establishes engineering behavior, not live model capability.\n`, { mode: 0o600 });
}
export async function initializeVerification(directory: string, level: "quick" | "full", sourceContentHash: string, images: VerificationReport["images"], platform: string, verificationId = directory.split("/").at(-1)!): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await save(directory, seal({ schemaVersion: 1, evidenceKind: "mock", verificationId, level, sourceContentHash, images, platform, createdAt: new Date().toISOString(), status: "INCOMPLETE", checks: [], pendingPlatformGates: ["Native platform coverage is documented in docs/verification.md", "Native TUI, OAuth, and live-provider behavior are not certified by this command"] }));
}
export async function recordVerification(directory: string, id: string, exitCode: number): Promise<VerificationReport> {
  const prior = validateVerificationReport(await readJson(join(directory, "verification.json")));
  if (prior.checks.some((c) => c.id === id)) throw new Error("Verification checks cannot be replaced; start a new verification");
  const expectedExitCode = id === "mock-smoke" ? 1 : 0;
  const log = `${id}.log`;
  const text = await readFile(join(directory, log), "utf8");
  // Reports retain command evidence; sanitize control sequences in the shareable log.
  const sanitized = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  await writeFile(join(directory, log), sanitized, { mode: 0o600 });
  const checks = [...prior.checks, { id, objective: OBJECTIVES[id] ?? "unknown", exitCode, expectedExitCode, status: exitCode === expectedExitCode ? "PASS" as const : "FAIL" as const, log, logHash: digest(sanitized) }];
  const { reportHash, ...rest } = prior;
  const report = seal({ ...rest, checks, status: checks.some((c) => c.status === "FAIL") ? "FAIL" : checks.length === (prior.level === "full" ? FULL_CHECKS : QUICK_CHECKS).length ? "PASS" : "INCOMPLETE" });
  await save(directory, report);
  return report;
}

export interface ProviderLedgerEntry { sequence: number; model: string; role: "classifier" | "coding"; tools: number; response: "text" | "tool"; inputTokens: number; outputTokens: number; }
export async function verifyMockLedger(directory: string): Promise<void> {
  const { manifest, trials } = await loadExperimentRecords(directory);
  if (manifest.evidenceKind !== "mock" || manifest.suite !== "smoke" || manifest.corpus?.id && manifest.corpus.id !== "core") throw new Error("Ledger gate requires the core mock smoke");
  const counts: Record<string, number> = {};
  for (const trial of trials) {
    if (!trial.result || !["pass", "fail"].includes(trial.outcome) || trial.physicalAttempts.length !== 1) throw new Error("Mock smoke must contain one terminal attempt per trial");
    const run = trial.result;
    const ledger = await readJson(join(directory, "attempts", run.identity.attemptId!, "provider-ledger.json")) as ProviderLedgerEntry[];
    if (!Array.isArray(ledger) || ledger.length === 0 || ledger.some((entry, index) => entry.sequence !== index + 1)) throw new Error("Missing or unordered provider ledger");
    const classifier = ledger.filter((e) => e.role === "classifier");
    const coding = ledger.filter((e) => e.role === "coding");
    if (classifier.length !== (trial.mode === "routed" ? 1 : 0) || classifier.some((e) => e.tools !== 0 || e.model !== "classifier") || (classifier.length && ledger[0]?.role !== "classifier")) throw new Error("Classifier request count, order, identity, or tool boundary violated");
    if (coding.length !== 2 || coding.some((e) => e.model !== run.decision?.selectedTier) || coding[0]?.response !== "tool" || coding[1]?.response !== "text") throw new Error("Coding request identity or tool sequence violated");
    for (const [role, rows] of [["classifier", classifier], ["coding", coding]] as const) {
      const usage = run.usage[role];
      if (usage.status !== "complete" || usage.observedCalls !== rows.length || usage.totalTokens !== rows.reduce((n, e) => n + e.inputTokens + e.outputTokens, 0)) throw new Error(`Provider ledger disagrees with ${role} accounting`);
    }
    if (run.usage.compaction.observedCalls !== 0 || run.usage.total.totalTokens !== ledger.reduce((n, e) => n + e.inputTokens + e.outputTokens, 0)) throw new Error("Provider ledger disagrees with total usage");
    counts[`${trial.mode}:${trial.outcome}`] = (counts[`${trial.mode}:${trial.outcome}`] ?? 0) + 1;
  }
  const expected = { "weak-only:pass": 2, "weak-only:fail": 1, "strong-only:pass": 3, "routed:pass": 2, "routed:fail": 1 };
  if (trials.length !== 9 || Object.entries(expected).some(([key, value]) => counts[key] !== value) || trials.filter((t) => t.result?.decision?.source === "classifier-fallback").length !== 1) throw new Error("Unexpected independently validated smoke matrix");
}
