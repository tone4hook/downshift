import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import type {
  ExecutionStatus,
  IndependentValidationResult,
  ValidationCheckResult,
} from "../artifacts/run-artifacts.js";
import type { LoadedTask, TaskCheck } from "./task.js";
import { assertSafeRelativePath } from "./task.js";
import {
  applySubmission,
  exportSubmission,
  materializeTask,
  validateSubmissionExport,
  type SubmissionExport,
} from "./workspace.js";

interface ValidatorDefinition {
  schemaVersion: 1;
  taskId: string;
  hiddenChecks: TaskCheck[];
  referenceDirectory: string;
  incompleteDirectory: string;
  mutantDirectories?: string[];
}

export interface ReferenceVerification {
  baseline: IndependentValidationResult;
  reference: IndependentValidationResult;
  incomplete: IndependentValidationResult;
  mutants?: Record<string, IndependentValidationResult>;
}

const validatorSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "taskId",
    "hiddenChecks",
    "referenceDirectory",
    "incompleteDirectory",
  ],
  properties: {
    schemaVersion: { const: 1 },
    taskId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    hiddenChecks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "argv"],
        properties: {
          name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
          argv: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
      },
    },
    referenceDirectory: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    incompleteDirectory: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    mutantDirectories: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^mutant-[a-z0-9-]{1,56}$" } },
  },
} as const;

const ajv = new Ajv2020Module.default({ allErrors: true, strict: false });
const validateValidator = ajv.compile(validatorSchema);
const typescriptBin = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/typescript/bin/tsc",
);

async function loadValidator(task: LoadedTask): Promise<ValidatorDefinition> {
  const value: unknown = JSON.parse(
    await readFile(join(task.evaluatorDirectory, "validator.json"), "utf8"),
  );
  if (!validateValidator(value)) {
    throw new Error(`Invalid evaluator definition: ${ajv.errorsText(validateValidator.errors)}`);
  }
  const definition = structuredClone(value) as ValidatorDefinition;
  if (definition.taskId !== task.definition.id) throw new Error("Evaluator task ID mismatch");
  return definition;
}

function resolveArg(value: string, workspace: string, evaluatorDirectory: string): string {
  if (value === "{workspace}") return workspace;
  if (value === "{evaluator}") return evaluatorDirectory;
  if (value.startsWith("{workspace}/")) {
    return join(workspace, assertSafeRelativePath(value.slice("{workspace}/".length)));
  }
  if (value.startsWith("{evaluator}/")) {
    return join(
      evaluatorDirectory,
      assertSafeRelativePath(value.slice("{evaluator}/".length)),
    );
  }
  return value;
}

async function runCheck(
  check: TaskCheck,
  workspace: string,
  evaluatorDirectory: string,
  outputDirectory: string,
  timeoutMs: number,
): Promise<ValidationCheckResult> {
  const started = Date.now();
  const stdoutArtifact = `${check.name}.stdout.txt`;
  const stderrArtifact = `${check.name}.stderr.txt`;
  const argv = check.argv.map((value) => resolveArg(value, workspace, evaluatorDirectory));
  const [command, ...args] = argv;
  if (!command) throw new Error(`Validation check ${check.name} has no command`);
  const nodeTest = command === "node" && args.includes("--test");
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const asset = (name: string) => fileURLToPath(new URL(`./${name}.${extension}`, import.meta.url));
  const effectiveArgs = nodeTest ? [
    "--experimental-strip-types", "--import", asset("validation-guard"),
    "--test-reporter", asset("validation-reporter"), ...args,
  ] : args;
  return new Promise((resolve) => {
    const child = spawn(command, effectiveArgs, {
      cwd: workspace,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: "/tmp",
        TMPDIR: "/tmp",
        LAB_SUBMISSION_ROOT: workspace,
        LAB_EVALUATOR_ROOT: evaluatorDirectory,
        LAB_TYPESCRIPT_BIN: typescriptBin,
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    let completion = "";
    child.stdio[3]!.on("data", (chunk: Buffer) => {
      if (completion.length < 4096) completion += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    const finish = async (
      status: ValidationCheckResult["status"],
      exitCode: number | null,
      reason: string | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await Promise.all([
        writeFile(join(outputDirectory, stdoutArtifact), Buffer.concat(stdout), { mode: 0o600 }),
        writeFile(join(outputDirectory, stderrArtifact), Buffer.concat(stderr), { mode: 0o600 }),
      ]);
      resolve({
        name: check.name,
        status,
        exitCode,
        durationMs: Date.now() - started,
        stdoutArtifact,
        stderrArtifact,
        reason,
      });
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (outputExceeded) return;
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) {
        outputExceeded = true;
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              void finish("error", null, (error as Error).message);
            }
          }
        } else {
          child.kill("SIGKILL");
        }
        return;
      }
      target.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr!.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => void finish("error", null, error.message));
    child.once("close", (code, signal) => {
      if (outputExceeded) {
        void finish("fail", null, "validation output limit exceeded");
      } else if (timedOut) {
        void finish("fail", null, "validation timeout");
      } else if (code === 0) {
        let completed = !nodeTest;
        if (nodeTest) {
          try { completed = JSON.parse(completion).completed === true; } catch { /* fail closed */ }
        }
        void finish(completed ? "pass" : "fail", 0,
          completed ? null : "trusted test runner did not confirm completed assertions");
      } else {
        void finish("fail", code, signal ? `terminated by ${signal}` : null);
      }
    });
  });
}

async function writeValidation(
  outputDirectory: string,
  result: IndependentValidationResult,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(outputDirectory, "validation.json"), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function validateSubmission(
  task: LoadedTask,
  submission: SubmissionExport,
  outputDirectory: string,
  executionStatus: ExecutionStatus = "completed",
): Promise<IndependentValidationResult> {
  const started = Date.now();
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  if (executionStatus === "cancelled") {
    const result: IndependentValidationResult = {
      status: "not-run",
      checks: [],
      durationMs: null,
    };
    await writeValidation(outputDirectory, result);
    return result;
  }
  if (submission.status === "rejected") {
    const result: IndependentValidationResult = {
      status: "fail",
      checks: [{
        name: "submission-policy",
        status: "fail",
        exitCode: null,
        durationMs: 0,
        stdoutArtifact: null,
        stderrArtifact: null,
        reason: submission.violations.join("; "),
      }],
      durationMs: Date.now() - started,
    };
    await writeValidation(outputDirectory, result);
    return result;
  }

  const validator = await loadValidator(task);
  const workspace = await mkdtemp(join(tmpdir(), `routing-lab-validator-${task.definition.id}-`));
  try {
    await materializeTask(task, workspace);
    await applySubmission(task, submission, workspace);
    const checks = [...task.definition.publicChecks, ...validator.hiddenChecks];
    const results: ValidationCheckResult[] = [];
    for (const check of checks) {
      results.push(
        await runCheck(
          check,
          workspace,
          task.evaluatorDirectory,
          outputDirectory,
          task.definition.limits.validationTimeoutSeconds * 1000,
        ),
      );
    }
    const status = results.some((check) => check.status === "error")
      ? "error"
      : results.every((check) => check.status === "pass")
        ? "pass"
        : "fail";
    const result: IndependentValidationResult = {
      status,
      checks: results,
      durationMs: Date.now() - started,
    };
    await writeValidation(outputDirectory, result);
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function overlaySolution(source: string, workspace: string): Promise<void> {
  async function copy(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const from = join(directory, entry.name);
      const to = join(workspace, relative);
      if (entry.isDirectory()) {
        await mkdir(to, { recursive: true });
        await copy(from, relative);
      } else if (entry.isFile()) {
        await mkdir(join(to, ".."), { recursive: true });
        await copyFile(from, to);
      } else {
        throw new Error(`Reference solution contains unsupported entry: ${relative}`);
      }
    }
  }
  await copy(source, "");
}

async function evaluateVariant(
  task: LoadedTask,
  source: string | null,
  root: string,
  name: string,
): Promise<IndependentValidationResult> {
  const workspace = join(root, `${name}-workspace`);
  const exported = join(root, `${name}-export`);
  const validation = join(root, `${name}-validation`);
  await materializeTask(task, workspace);
  if (source) await overlaySolution(source, workspace);
  const submission = await exportSubmission(task, workspace, exported);
  return validateSubmission(task, submission, validation);
}

export async function verifyReference(
  task: LoadedTask,
  outputDirectory: string,
): Promise<ReferenceVerification> {
  const validator = await loadValidator(task);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const result: ReferenceVerification = {
    baseline: await evaluateVariant(task, null, outputDirectory, "baseline"),
    reference: await evaluateVariant(
      task,
      join(task.evaluatorDirectory, basename(validator.referenceDirectory)),
      outputDirectory,
      "reference",
    ),
    incomplete: await evaluateVariant(
      task,
      join(task.evaluatorDirectory, basename(validator.incompleteDirectory)),
      outputDirectory,
      "incomplete",
    ),
  };
  if (validator.mutantDirectories) {
    result.mutants = {};
    for (const name of validator.mutantDirectories) {
      result.mutants[name] = await evaluateVariant(task, join(task.evaluatorDirectory, name), outputDirectory, name);
    }
  }
  await writeFile(join(outputDirectory, "fixture-quality.json"), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  if (
    result.baseline.status !== "fail" ||
    result.reference.status !== "pass" ||
    result.incomplete.status !== "fail" ||
    Object.values(result.mutants ?? {}).some((mutant) => mutant.status !== "fail")
  ) {
    throw new Error("Fixture quality gate failed");
  }
  return result;
}

export async function readSubmission(path: string): Promise<SubmissionExport> {
  return validateSubmissionExport(JSON.parse(await readFile(path, "utf8")));
}
