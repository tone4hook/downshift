import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Ajv2020Module from "ajv/dist/2020.js";
import {
  assertSafeRelativePath,
  sha256,
  type LoadedTask,
  type TaskDefinition,
  type TaskFile,
} from "./task.js";

export interface SubmissionChange {
  path: string;
  kind: "add" | "modify" | "delete";
  sha256: string | null;
  bytesBase64: string | null;
}

export interface SubmissionExport {
  schemaVersion: 1;
  taskId: string;
  sourceHash: string;
  status: "accepted" | "rejected";
  violations: string[];
  changes: SubmissionChange[];
  submissionHash: string;
}

const hashPattern = "^[0-9a-f]{64}$";
export const SUBMISSION_EXPORT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "taskId",
    "sourceHash",
    "status",
    "violations",
    "changes",
    "submissionHash",
  ],
  properties: {
    schemaVersion: { const: 1 },
    taskId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    sourceHash: { type: "string", pattern: hashPattern },
    status: { enum: ["accepted", "rejected"] },
    violations: { type: "array", items: { type: "string", minLength: 1 } },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "kind", "sha256", "bytesBase64"],
        properties: {
          path: { type: "string", minLength: 1 },
          kind: { enum: ["add", "modify", "delete"] },
          sha256: { type: ["string", "null"], pattern: hashPattern },
          bytesBase64: { type: ["string", "null"] },
        },
      },
    },
    submissionHash: { type: "string", pattern: hashPattern },
  },
} as const;

const ajv = new Ajv2020Module.default({ allErrors: true, strict: false });
const validateSubmission = ajv.compile(SUBMISSION_EXPORT_SCHEMA);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function durableWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function ensureFreshDirectory(path: string): Promise<void> {
  if (await exists(path)) {
    if ((await readdir(path)).length !== 0) throw new Error(`Trial workspace must be empty: ${path}`);
    return;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function runSetup(task: TaskDefinition, workspace: string): Promise<void> {
  const [command, ...args] = task.setupArgv;
  if (!command) throw new Error("Task setup command is empty");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
      },
    });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            finish(error as Error);
            return;
          }
        }
      } else {
        child.kill("SIGKILL");
      }
      finish(new Error("Task dependency setup timed out"));
    }, task.limits.validationTimeoutSeconds * 1000);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 65536) stderr += chunk.toString();
    });
    child.once("error", (error) =>
      finish(new Error(`Task dependency setup failed to start: ${error.message}`)),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else {
        finish(
          new Error(
            `Task dependency setup failed (${signal ?? `exit ${code ?? "unknown"}`}): ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

export async function materializeTask(
  task: LoadedTask,
  destination: string,
): Promise<{ taskHash: string; sourceHash: string }> {
  await ensureFreshDirectory(destination);
  for (const file of task.definition.fixture.files) {
    const path = assertSafeRelativePath(file.path);
    const source = join(task.fixtureRoot, path);
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    if (sha256(await readFile(target)) !== file.sha256) {
      throw new Error(`Materialized fixture hash mismatch: ${path}`);
    }
  }
  await runSetup(task.definition, destination);
  return { taskHash: task.taskHash, sourceHash: task.definition.fixture.hash };
}

async function scanWorkspace(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (!prefix && (entry.name === "node_modules" || entry.name === ".git")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertSafeRelativePath(path);
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Submission contains forbidden symlink: ${path}`);
      if (info.isDirectory()) {
        await walk(absolute, path);
      } else if (info.isFile()) {
        files.set(path, await readFile(absolute));
      } else {
        throw new Error(`Submission contains non-regular file: ${path}`);
      }
    }
  }
  await walk(root, "");
  return files;
}

function isEditable(task: TaskDefinition, path: string): boolean {
  return task.editableDirectories.some((directory) => path.startsWith(`${directory}/`));
}

function submissionHash(changes: SubmissionChange[]): string {
  return sha256(
    changes
      .map((change) => `${change.path}\0${change.kind}\0${change.sha256 ?? ""}\0`)
      .join(""),
  );
}

export function validateSubmissionExport(value: unknown): SubmissionExport {
  if (!validateSubmission(value)) {
    throw new Error(`Invalid submission export: ${ajv.errorsText(validateSubmission.errors)}`);
  }
  const submission = structuredClone(value) as SubmissionExport;
  const seen = new Set<string>();
  for (const change of submission.changes) {
    assertSafeRelativePath(change.path);
    if (seen.has(change.path)) throw new Error(`Duplicate submission path: ${change.path}`);
    seen.add(change.path);
    if (change.kind === "delete") {
      if (change.sha256 !== null || change.bytesBase64 !== null) {
        throw new Error(`Deleted submission path carries bytes: ${change.path}`);
      }
    } else {
      if (change.sha256 === null || change.bytesBase64 === null) {
        throw new Error(`Submission path is missing bytes: ${change.path}`);
      }
      if (sha256(Buffer.from(change.bytesBase64, "base64")) !== change.sha256) {
        throw new Error(`Submission content hash mismatch: ${change.path}`);
      }
    }
  }
  if (submissionHash(submission.changes) !== submission.submissionHash) {
    throw new Error("Submission aggregate hash mismatch");
  }
  return submission;
}

export async function exportSubmission(
  task: LoadedTask,
  workspace: string,
  outputDirectory: string,
): Promise<SubmissionExport> {
  const current = await scanWorkspace(workspace);
  const baseline = new Map(task.definition.fixture.files.map((file) => [file.path, file]));
  const paths = [...new Set([...baseline.keys(), ...current.keys()])].sort();
  const violations: string[] = [];
  const changes: SubmissionChange[] = [];
  for (const path of paths) {
    const original = baseline.get(path);
    const bytes = current.get(path);
    const currentHash = bytes ? sha256(bytes) : null;
    if (original?.sha256 === currentHash) continue;
    const protectedPath = task.definition.protectedPaths.includes(path) || !isEditable(task.definition, path);
    if (protectedPath) {
      violations.push(`protected or non-editable path changed: ${path}`);
      continue;
    }
    if (bytes && bytes.length > task.definition.limits.maxFileBytes) {
      violations.push(`file exceeds ${task.definition.limits.maxFileBytes} bytes: ${path}`);
      continue;
    }
    if (!original && bytes && !task.definition.allowedNewFileExtensions.includes(extname(path))) {
      violations.push(`new file extension is not allowed: ${path}`);
      continue;
    }
    changes.push({
      path,
      kind: bytes ? (original ? "modify" : "add") : "delete",
      sha256: bytes ? currentHash : null,
      bytesBase64: bytes ? bytes.toString("base64") : null,
    });
  }
  const result = validateSubmissionExport({
    schemaVersion: 1,
    taskId: task.definition.id,
    sourceHash: task.definition.fixture.hash,
    status: violations.length === 0 ? "accepted" : "rejected",
    violations,
    changes: violations.length === 0 ? changes : [],
    submissionHash: submissionHash(violations.length === 0 ? changes : []),
  });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await durableWrite(join(outputDirectory, "submission.json"), `${JSON.stringify(result, null, 2)}\n`);
  const patch = result.changes
    .map((change) => `${change.kind.toUpperCase()} ${change.path} ${change.sha256 ?? ""}`.trimEnd())
    .join("\n");
  await durableWrite(join(outputDirectory, "patch.diff"), patch ? `${patch}\n` : "");
  return result;
}

export async function applySubmission(
  task: LoadedTask,
  submission: SubmissionExport,
  workspace: string,
): Promise<void> {
  if (submission.status !== "accepted") throw new Error("Rejected submission cannot be applied");
  if (
    submission.taskId !== task.definition.id ||
    submission.sourceHash !== task.definition.fixture.hash
  ) {
    throw new Error("Submission does not match the task fixture");
  }
  for (const change of submission.changes) {
    if (!isEditable(task.definition, change.path)) {
      throw new Error(`Submission path is outside the editable allowlist: ${change.path}`);
    }
    const target = join(workspace, assertSafeRelativePath(change.path));
    if (change.kind === "delete") {
      await rm(target, { force: true });
    } else {
      const bytes = Buffer.from(change.bytesBase64!, "base64");
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, "w", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    }
  }
}
