import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SwitchyardBridgeClient } from "../../src/bridge/client.js";
import {
  assertContainerStateWritable,
  resolveContainerPaths,
  validateAuthProfile,
} from "../../src/container/paths.js";
import { createContainerRuntime, validatePiProfile } from "../../src/container/session-runtime.js";

const cleanup: string[] = [];

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "routing-lab-phase02-"));
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("phase 02 container runtime", () => {
  it.each(["default", "team-a", "a", "p123"])("accepts an explicit safe auth profile %s", (profile) => {
    expect(validateAuthProfile(profile)).toBe(profile);
  });

  it.each(["", "-bad", "UPPER", "bad_name", "a".repeat(33)])("rejects unsafe auth profile %s", (profile) => {
    expect(() => validateAuthProfile(profile)).toThrow(/LAB_AUTH_PROFILE/);
  });

  it("keeps authentication and Pi session paths in separate roots", async () => {
    const root = await temporaryRoot();
    const profile = join(root, "profile");
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await Promise.all([mkdir(profile), mkdir(state), mkdir(join(workspace, "node_modules"), { recursive: true })]);
    const paths = resolveContainerPaths({
      LAB_AUTH_PROFILE: "mock-only",
      PI_PROFILE_ROOT: profile,
      LAB_PROJECT_STATE: state,
      LAB_WORKSPACE: workspace,
      SWITCHYARD_BRIDGE: resolve("rust/switchyard-bridge/target/debug/switchyard-bridge"),
    });
    await expect(assertContainerStateWritable(paths)).resolves.toBeUndefined();
    expect(paths.authPath.startsWith(profile)).toBe(true);
    expect(paths.modelsPath.startsWith(profile)).toBe(true);
    expect(paths.projectAgentDir.startsWith(state)).toBe(true);
    expect(paths.sessionDirectory.startsWith(state)).toBe(true);
    expect(paths.projectAgentDir.startsWith(profile)).toBe(false);
  });

  it("rejects a corrupt Pi credential store without replacing it", async () => {
    const root = await temporaryRoot();
    const authPath = join(root, "auth.json");
    await writeFile(authPath, "{not-json\n", { mode: 0o600 });
    await expect(validatePiProfile(authPath)).rejects.toThrow(/credential store is corrupt/);
    await expect(import("node:fs/promises").then(({ readFile }) => readFile(authPath, "utf8"))).resolves.toBe(
      "{not-json\n",
    );
  });

  it("binds Pi auth to the profile while keeping settings and sessions project-scoped", async () => {
    const root = await temporaryRoot();
    const profile = join(root, "profile");
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await Promise.all([mkdir(profile), mkdir(state), mkdir(join(workspace, "node_modules"), { recursive: true })]);
    const runtime = await createContainerRuntime({
      LAB_AUTH_PROFILE: "mock-only",
      PI_PROFILE_ROOT: profile,
      LAB_PROJECT_STATE: state,
      LAB_WORKSPACE: workspace,
      SWITCHYARD_BRIDGE: resolve("rust/switchyard-bridge/target/debug/switchyard-bridge"),
    });
    expect(runtime.paths.authPath).toBe(join(profile, "auth.json"));
    expect(runtime.sessionRuntime.cwd).toBe(workspace);
    expect(runtime.sessionRuntime.services.agentDir).toBe(join(state, "settings"));
    expect(runtime.sessionRuntime.session.sessionManager.getSessionDir()).toBe(join(state, "sessions"));
    await runtime.sessionRuntime.dispose();
  });

  it("starts and reaps the compiled bridge", async () => {
    const bridge = await SwitchyardBridgeClient.start(
      resolve("rust/switchyard-bridge/target/debug/switchyard-bridge"),
    );
    const pid = bridge.process.pid;
    expect(pid).toBeTypeOf("number");
    await bridge.dispose();
    expect(bridge.process.exitCode ?? bridge.process.signalCode).not.toBeNull();
  });
});
