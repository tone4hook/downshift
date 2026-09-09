import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";

export interface TaskFile {
  path: string;
  sha256: string;
}

export interface TaskCheck {
  name: string;
  argv: string[];
}

export interface TaskDefinition {
  schemaVersion: 1;
  id: string;
  split: "dev" | "heldout";
  publicPrompt: string;
  fixture: {
    directory: string;
    hash: string;
    files: TaskFile[];
  };
  setupArgv: string[];
  publicChecks: TaskCheck[];
  evaluatorReferenceId: string;
  validatorHash: string;
  editableDirectories: string[];
  allowedNewFileExtensions: string[];
  protectedPaths: string[];
  limits: {
    validationTimeoutSeconds: number;
    maxFileBytes: number;
  };
}

export interface EvaluationRoots {
  tasksRoot: string;
  fixturesRoot: string;
  evaluatorRoot: string;
}

export interface LoadedTask {
  definition: TaskDefinition;
  taskHash: string;
  fixtureRoot: string;
  evaluatorDirectory: string;
}

const hashPattern = "^[0-9a-f]{64}$";
const relativePathPattern = "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[^\\u0000]+$";
const argvSchema = {
  type: "array",
  minItems: 1,
  items: { type: "string", minLength: 1 },
} as const;

export const TASK_DEFINITION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "split",
    "publicPrompt",
    "fixture",
    "setupArgv",
    "publicChecks",
    "evaluatorReferenceId",
    "validatorHash",
    "editableDirectories",
    "allowedNewFileExtensions",
    "protectedPaths",
    "limits",
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    split: { enum: ["dev", "heldout"] },
    publicPrompt: { type: "string", minLength: 1 },
    fixture: {
      type: "object",
      additionalProperties: false,
      required: ["directory", "hash", "files"],
      properties: {
        directory: { type: "string", pattern: relativePathPattern },
        hash: { type: "string", pattern: hashPattern },
        files: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "sha256"],
            properties: {
              path: { type: "string", pattern: relativePathPattern },
              sha256: { type: "string", pattern: hashPattern },
            },
          },
        },
      },
    },
    setupArgv: argvSchema,
    publicChecks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "argv"],
        properties: {
          name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
          argv: argvSchema,
        },
      },
    },
    evaluatorReferenceId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    validatorHash: { type: "string", pattern: hashPattern },
    editableDirectories: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: relativePathPattern },
    },
    allowedNewFileExtensions: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: "^\\.[a-z0-9]+$" },
    },
    protectedPaths: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: relativePathPattern },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["validationTimeoutSeconds", "maxFileBytes"],
      properties: {
        validationTimeoutSeconds: { type: "integer", minimum: 1, maximum: 300 },
        maxFileBytes: { type: "integer", minimum: 1, maximum: 1048576 },
      },
    },
  },
} as const;

const ajv = new Ajv2020Module.default({ allErrors: true, strict: false });
const validateTask = ajv.compile(TASK_DEFINITION_SCHEMA);

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertSafeRelativePath(path: string): string {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes("\n") ||
    path.includes("\r") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe relative path: ${JSON.stringify(path)}`);
  }
  return path;
}

export function fixtureManifestHash(files: TaskFile[]): string {
  return sha256(
    [...files]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((file) => `${file.path}\0${file.sha256}\0`)
      .join(""),
  );
}

export async function hashDirectory(root: string): Promise<{ hash: string; files: TaskFile[] }> {
  const files: TaskFile[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertSafeRelativePath(path);
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Symlink is forbidden in owned task content: ${path}`);
      if (info.isDirectory()) {
        await walk(absolute, path);
      } else if (info.isFile()) {
        files.push({ path, sha256: sha256(await readFile(absolute)) });
      } else {
        throw new Error(`Non-regular task content is forbidden: ${path}`);
      }
    }
  }
  await walk(root, "");
  return { files, hash: fixtureManifestHash(files) };
}

export function validateTaskDefinition(value: unknown): TaskDefinition {
  if (!validateTask(value)) {
    throw new Error(`Invalid task definition: ${ajv.errorsText(validateTask.errors)}`);
  }
  const task = structuredClone(value) as TaskDefinition;
  const paths = task.fixture.files.map((file) => assertSafeRelativePath(file.path));
  if (new Set(paths).size !== paths.length) throw new Error("Task fixture file paths must be unique");
  task.editableDirectories.forEach(assertSafeRelativePath);
  task.protectedPaths.forEach(assertSafeRelativePath);
  if (task.fixture.hash !== fixtureManifestHash(task.fixture.files)) {
    throw new Error("Task fixture hash does not match its file manifest");
  }
  return task;
}

export async function loadTaskDefinition(
  taskId: string,
  roots: EvaluationRoots,
): Promise<LoadedTask> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskId)) throw new Error(`Invalid task ID: ${taskId}`);
  const taskPath = join(roots.tasksRoot, `${taskId}.json`);
  const source = await readFile(taskPath, "utf8");
  const definition = validateTaskDefinition(JSON.parse(source));
  if (definition.id !== taskId) throw new Error(`Task ID mismatch in ${taskPath}`);
  const fixtureRoot = join(roots.fixturesRoot, assertSafeRelativePath(definition.fixture.directory));
  const fixture = await hashDirectory(fixtureRoot);
  if (
    fixture.hash !== definition.fixture.hash ||
    JSON.stringify(fixture.files) !== JSON.stringify(definition.fixture.files)
  ) {
    throw new Error(`Public fixture does not match the immutable manifest for ${taskId}`);
  }
  const evaluatorDirectory = join(
    roots.evaluatorRoot,
    assertSafeRelativePath(definition.evaluatorReferenceId),
  );
  const validator = await hashDirectory(evaluatorDirectory);
  if (validator.hash !== definition.validatorHash) {
    throw new Error(`Evaluator assets do not match the immutable validator hash for ${taskId}`);
  }
  return {
    definition,
    taskHash: sha256(source),
    fixtureRoot,
    evaluatorDirectory,
  };
}
