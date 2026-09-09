import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ContainerPaths {
  authProfile: string;
  authPath: string;
  modelsPath: string;
  projectStateRoot: string;
  projectAgentDir: string;
  sessionDirectory: string;
  workspace: string;
  dependencyDirectory: string;
  bridgeExecutable: string;
}

function absolutePath(value: string | undefined, fallback: string, name: string): string {
  const path = value ?? fallback;
  if (!isAbsolute(path) || path.includes("\n")) {
    throw new Error(`${name} must be an absolute path without newlines`);
  }
  return path;
}

export function validateAuthProfile(value: string | undefined): string {
  const profile = value ?? "default";
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error("LAB_AUTH_PROFILE must match [a-z0-9][a-z0-9-]{0,31}");
  }
  return profile;
}

export function resolveContainerPaths(environment: NodeJS.ProcessEnv = process.env): ContainerPaths {
  const profileRoot = absolutePath(environment.PI_PROFILE_ROOT, "/pi-profile", "PI_PROFILE_ROOT");
  const projectStateRoot = absolutePath(environment.LAB_PROJECT_STATE, "/project-state", "LAB_PROJECT_STATE");
  const workspace = absolutePath(environment.LAB_WORKSPACE, "/workspace", "LAB_WORKSPACE");
  return {
    authProfile: validateAuthProfile(environment.LAB_AUTH_PROFILE),
    authPath: join(profileRoot, "auth.json"),
    modelsPath: join(profileRoot, "models.json"),
    projectStateRoot,
    projectAgentDir: join(projectStateRoot, "settings"),
    sessionDirectory: join(projectStateRoot, "sessions"),
    workspace,
    dependencyDirectory: join(workspace, "node_modules"),
    bridgeExecutable: absolutePath(
      environment.SWITCHYARD_BRIDGE,
      "/usr/local/bin/switchyard-bridge",
      "SWITCHYARD_BRIDGE",
    ),
  };
}

export async function assertContainerStateWritable(paths: ContainerPaths): Promise<void> {
  await Promise.all([
    access(dirname(paths.authPath), constants.W_OK),
    access(paths.projectStateRoot, constants.W_OK),
    access(paths.dependencyDirectory, constants.W_OK),
  ]);
}
