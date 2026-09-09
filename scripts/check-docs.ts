import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requiredDocuments = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "docs/architecture.md",
  "docs/evaluation-guide.md",
  "docs/verification.md",
  "docs/upstream-compatibility.md",
  "docs/examples/mock-report.md",
  "docs/task-authoring.md",
  "docs/examples/readiness-reports.md",
] as const;

const forbiddenPlanningOrAgentPaths = [
  "specs",
  "docs/handoffs",
  ".agents",
  ".claude",
  ".codex",
  ".copilot",
  ".cursor",
  ".github/copilot-instructions.md",
  ".github/skills",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
] as const;

const requiredReadmeCommands = [
  "./route-agent build",
  "./route-agent auth",
  "./route-agent models --refresh",
  "./route-agent config check",
  "./route-agent doctor",
  "./route-agent run --project",
  "./route-agent eval fixtures --suite full",
  "./route-agent eval run --suite smoke",
  "./route-agent eval verify --level quick",
  "./route-agent eval verify --level full",
  "./route-agent report --experiment",
] as const;

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".pnpm-store", ".git", "results", "target", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function checkDocumentation(root: string): Promise<{ files: number; links: number }> {
  const problems: string[] = [];
  for (const path of requiredDocuments) {
    if (!await exists(join(root, path))) problems.push(`missing required document: ${path}`);
  }
  for (const path of forbiddenPlanningOrAgentPaths) {
    if (await exists(join(root, path))) problems.push(`internal planning or coding-agent path must not be published: ${path}`);
  }

  const files = await markdownFiles(root);
  let links = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]?.trim();
      if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
      const targetPath = target.split("#", 1)[0];
      if (!targetPath) continue;
      links += 1;
      let decoded: string;
      try {
        decoded = decodeURIComponent(targetPath);
      } catch {
        problems.push(`${relative(root, file)}: malformed link ${target}`);
        continue;
      }
      if (!await exists(resolve(dirname(file), decoded))) {
        problems.push(`${relative(root, file)}: broken link ${target}`);
      }
    }
  }

  const readme = await readFile(join(root, "README.md"), "utf8");
  for (const command of requiredReadmeCommands) {
    if (!readme.includes(command)) problems.push(`README.md: missing command example ${command}`);
  }
  if (!/host Node(?:\.js)?.{0,60}not required/i.test(readme)) {
    problems.push("README.md: missing explicit host language-runtime guidance");
  }
  if (!readme.includes("config/lab.local.json") || !readme.includes("ignored by Git")) {
    problems.push("README.md: missing local configuration privacy guidance");
  }
  if (!readme.includes("--live") || !readme.includes("consume")) {
    problems.push("README.md: missing explicit live-provider usage warning");
  }

  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  for (const command of [
    "./route-agent build",
    "./route-agent eval verify --level full",
    "results/verify-*/verification.json",
    "results/verify-*/*.log",
  ]) {
    if (!workflow.includes(command)) problems.push(`ci.yml: missing required command ${command}`);
  }
  const launcher = await readFile(join(root, "route-agent"), "utf8");
  for (const command of ["dev -- pnpm typecheck", "dev -- pnpm test", "dev -- pnpm check:docs", "eval fixtures --suite full --corpus combined", "tests/host/release-smoke.sh"]) {
    if (!launcher.includes(command)) problems.push(`route-agent: full verification omits ${command}`);
  }
  if (/(?:--live|lab\.local\.json|route-agent auth)/.test(workflow)) {
    problems.push("ci.yml: live authentication or provider use is forbidden");
  }

  const example = await readFile(join(root, "docs/examples/mock-report.md"), "utf8");
  if (!example.includes("Evidence kind: `mock`") || !example.includes("not model-capability evidence")) {
    problems.push("docs/examples/mock-report.md: mock evidence label is incomplete");
  }

  if (problems.length > 0) throw new Error(`Documentation checks failed:\n${problems.join("\n")}`);
  return { files: files.length, links };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkDocumentation(root);
  process.stdout.write(`Validated ${result.files} Markdown documents and ${result.links} local links.\n`);
}
