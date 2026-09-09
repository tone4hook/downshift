import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

export type SupportedPackageManager = "npm" | "pnpm";

export interface ProjectPlan {
  projectId: string;
  packageManager: SupportedPackageManager;
  declaredPackageManager: string | null;
  lockfile: "package-lock.json" | "pnpm-lock.yaml";
  lockHash: string;
}

interface PackageManifest {
  name?: unknown;
  packageManager?: unknown;
  workspaces?: unknown;
}

const STATE_FILE = ".route-agent-state.json";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseManifest(contents: string, path: string): PackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Project package.json is invalid JSON: ${path}`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Project package.json must contain a JSON object: ${path}`);
  }
  return value as PackageManifest;
}

function declaredManager(value: unknown): { name: SupportedPackageManager; identity: string } | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error("packageManager must be a string when present");
  }
  const match = /^(npm|pnpm)@([0-9][0-9A-Za-z.+-]*)$/.exec(value);
  if (!match) {
    throw new Error("packageManager must declare an exact supported npm or pnpm version");
  }
  return { name: match[1] as SupportedPackageManager, identity: value };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function identifyProject(canonicalHostPath: string): {
  projectId: string;
  invocationId: string;
} {
  if (!canonicalHostPath.startsWith("/") || canonicalHostPath.includes("\n") || canonicalHostPath.includes(":")) {
    throw new Error("Canonical project path must be absolute and contain neither newlines nor ':'");
  }
  return {
    projectId: sha256(canonicalHostPath),
    invocationId: randomUUID(),
  };
}

export async function inspectProject(workspace: string, projectId = "unbound"): Promise<ProjectPlan> {
  const manifestPath = join(workspace, "package.json");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
  if (manifest.workspaces !== undefined || (await exists(join(workspace, "pnpm-workspace.yaml")))) {
    throw new Error("Nested workspace dependency layouts are unsupported in v0.1");
  }

  const candidates = (
    await Promise.all(
      (["package-lock.json", "pnpm-lock.yaml"] as const).map(async (name) => ({
        name,
        present: await exists(join(workspace, name)),
      })),
    )
  ).filter(({ present }) => present);
  if (candidates.length === 0) {
    throw new Error("Project requires exactly one supported root lockfile: package-lock.json or pnpm-lock.yaml");
  }
  if (candidates.length > 1) {
    throw new Error("Project has ambiguous npm/pnpm lockfiles; keep exactly one supported root lockfile");
  }

  const lockfile = candidates[0]!.name;
  const packageManager: SupportedPackageManager = lockfile === "package-lock.json" ? "npm" : "pnpm";
  const declaration = declaredManager(manifest.packageManager);
  if (declaration && declaration.name !== packageManager) {
    throw new Error(
      `packageManager declares ${declaration.name}, but ${basename(lockfile)} selects ${packageManager}`,
    );
  }
  const lockContents = await readFile(join(workspace, lockfile));
  return {
    projectId,
    packageManager,
    declaredPackageManager: declaration?.identity ?? null,
    lockfile,
    lockHash: sha256(lockContents),
  };
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} dependency installation failed (${signal ?? `exit ${code ?? "unknown"}`})`));
      }
    });
  });
}

async function packageManagerVersion(manager: SupportedPackageManager): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(manager, ["--version"], { shell: false, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Unable to determine ${manager} version (exit ${code ?? "unknown"})`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function clearDependencyDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const entry of await readdir(directory)) {
    await rm(join(directory, entry), { recursive: true, force: true });
  }
}

export async function prepareProject(
  workspace: string,
  dependencyDirectory: string,
  projectId = process.env.LAB_PROJECT_ID ?? "unbound",
): Promise<ProjectPlan> {
  const plan = await inspectProject(workspace, projectId);
  const managerVersion = await packageManagerVersion(plan.packageManager);
  const managerIdentity = `${plan.packageManager}@${managerVersion}`;
  if (plan.declaredPackageManager && plan.declaredPackageManager !== managerIdentity) {
    throw new Error(
      `Project requires ${plan.declaredPackageManager}, but the pinned container provides ${managerIdentity}`,
    );
  }
  const runtimeIdentity = [
    process.version,
    process.platform,
    process.arch,
    process.versions.modules,
    managerIdentity,
  ].join(":");
  const desiredState = {
    schemaVersion: 1,
    projectId: plan.projectId,
    lockHash: plan.lockHash,
    runtimeIdentity,
    packageManager: managerIdentity,
  };
  const marker = join(dependencyDirectory, STATE_FILE);
  let currentState = "";
  try {
    currentState = await readFile(marker, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const serializedState = `${JSON.stringify(desiredState)}\n`;
  if (currentState === serializedState) return plan;

  await clearDependencyDirectory(dependencyDirectory);
  if (plan.packageManager === "npm") {
    await run("npm", ["ci", "--cache", "/package-cache/npm"], workspace);
  } else {
    await run(
      "pnpm",
      ["install", "--frozen-lockfile", "--store-dir", "/package-cache/pnpm-store"],
      workspace,
    );
  }
  const temporaryMarker = `${marker}.${process.pid}.tmp`;
  await writeFile(temporaryMarker, serializedState, { mode: 0o600 });
  await rename(temporaryMarker, marker);
  return plan;
}

export async function dependencyState(dependencyDirectory: string): Promise<string> {
  return readFile(join(dependencyDirectory, STATE_FILE), "utf8");
}
