import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadExperimentRecords } from "./analysis.js";
import { routingWordings } from "./corpus.js";
import { atomicJson, digest, markdown } from "./records.js";

export async function prepareRoutingProbe(directory: string, output: string, evidenceKind: "mock" | "live"): Promise<void> {
  const { manifest, trials } = await loadExperimentRecords(directory);
  if (manifest.suite !== "dev" || manifest.evidenceKind !== evidenceKind || trials.some((t) => !["pass", "fail"].includes(t.outcome))) throw new Error("Routing probes require a completed development experiment with matching evidence; live requires --live");
  const jobs = manifest.tasks.flatMap(({ id, publicPrompt }) => routingWordings(publicPrompt).flatMap((prompt, wording) => Array.from({ length: 5 }, (_, sample) => ({ taskId: id, wording, sample, prompt }))));
  const plan = { schemaVersion: 1, evidenceKind, sourceManifestHash: manifest.manifestHash, fingerprint: manifest.fingerprints.value, jobs };
  await atomicJson(join(output, "probe-plan.json"), { ...plan, planHash: digest(plan) });
  await atomicJson(join(output, "config.json"), manifest.configuration);
  process.stdout.write(`auth-profile:${manifest.authProfile}\nprobe-calls:${jobs.length}\n`);
}
export async function reportRoutingProbe(directory: string, exitCode: number): Promise<void> {
  const plan = JSON.parse(await readFile(join(directory, "probe-plan.json"), "utf8"));
  const raw = await readFile(join(directory, "samples.jsonl"), "utf8");
  const samples = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  samples.forEach((row, index) => {
    const job = plan.jobs[index];
    if (!job || row.taskId !== job.taskId || row.wording !== job.wording || row.sample !== job.sample || row.planHash !== plan.planHash || !["ok", "error"].includes(row.status) || !Number.isFinite(row.durationMs) || row.durationMs < 0) throw new Error("Routing probe sample identity mismatch");
    if (row.status === "ok" && (!['weak','strong'].includes(row.selectedTier) || (row.probability !== null && (!Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1)) || (row.fallback && (row.probability !== null || row.selectedTier !== 'strong')))) throw new Error("Invalid routing probe verdict");
  });
  const tasks = [...new Set<string>(plan.jobs.map((j: { taskId: string }) => j.taskId))].map((taskId) => ({ taskId, wordings: [0, 1, 2].map((wording) => {
    const rows = samples.filter((s) => s.taskId === taskId && s.wording === wording && s.status === "ok");
    const probabilities = rows.flatMap((s) => s.probability === null ? [] : [s.probability as number]);
    return { wording, samples: rows.length, weak: rows.filter((s) => s.selectedTier === "weak").length, fallback: rows.filter((s) => s.fallback).length, invalidVerdictRate: rows.length ? rows.filter((s) => s.fallback).length / rows.length : null, minProbability: probabilities.length ? Math.min(...probabilities) : null, maxProbability: probabilities.length ? Math.max(...probabilities) : null, meanProbability: probabilities.length ? probabilities.reduce((a,b)=>a+b,0)/probabilities.length : null, meanLatencyMs: rows.length ? rows.reduce((a,s)=>a+s.durationMs,0)/rows.length : null };
  }), selectionChanges: [0,1,2,3,4].reduce((count, sample) => {
    const rows = samples.filter((s) => s.taskId === taskId && s.sample === sample && s.status === "ok");
    return count + (rows.length === 3 && new Set(rows.map((s)=>s.selectedTier)).size > 1 ? 1 : 0);
  },0) }));
  const report = { schemaVersion: 1, evidenceKind: plan.evidenceKind, kind: "classifier-diagnostic", sourceManifestHash: plan.sourceManifestHash, planHash: plan.planHash, exitCode, status: exitCode === 0 && samples.length === plan.jobs.length && samples.every((s)=>s.status==='ok') ? "complete" : "incomplete", planned: plan.jobs.length, recorded: samples.length, tasks, limitations: ["These are classifier-only requests with the original prompt and two presentation-preserving rewrites, five calls each.", "No new coding outcomes were measured. Selection variation is diagnostic, not an automatic failure.", "Infrastructure errors stop the probe; reruns use a new artifact directory and preserve prior evidence."] };
  await atomicJson(join(directory,"routing-probe.json"),report);
  await writeFile(join(directory,"routing-probe.md"), `# Routing sensitivity\n\n${report.evidenceKind} · classifier diagnostic · ${report.status}\n\nRecorded ${report.recorded}/${report.planned} requests.\n\n| Task | Wording | Samples | Weak | Fallback | Probability range | Mean latency ms |\n|---|---:|---:|---:|---:|---|---:|\n${tasks.flatMap((t)=>t.wordings.map((w)=>`| ${markdown(t.taskId)} | ${w.wording} | ${w.samples} | ${w.weak} | ${w.fallback} | ${w.minProbability??'unknown'}–${w.maxProbability??'unknown'} | ${w.meanLatencyMs??'unknown'} |`)).join('\n')}\n\n${tasks.map((t)=>`${markdown(t.taskId)}: ${t.selectionChanges}/5 matched sample positions change selection across wordings.`).join('\n\n')}\n\n${report.limitations.join('\n\n')}\n`, { mode: 0o600 });
}
