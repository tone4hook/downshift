import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identifyProject, inspectProject, prepareProject } from "../../src/launcher/project.js";

const cleanup: string[] = [];

async function temporaryProject(name = "project"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "routing-lab-phase03-"));
  cleanup.push(root);
  const project = join(root, name);
  await mkdir(project);
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "phase03-fixture", version: "1.0.0" }, null, 2)}\n`,
  );
  await writeFile(
    join(project, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "phase03-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "phase03-fixture", version: "1.0.0" } },
      },
      null,
      2,
    )}\n`,
  );
  return project;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("phase 03 project planning", () => {
  it("derives a stable project key and unique invocation identities", async () => {
    const project = await temporaryProject("project with spaces");
    const alias = join(project, "..", "project-alias");
    await symlink(project, alias);
    const canonical = await import("node:fs/promises").then(({ realpath }) => realpath(alias));
    const first = identifyProject(canonical);
    const second = identifyProject(canonical);
    expect(first.projectId).toMatch(/^[0-9a-f]{64}$/);
    expect(second.projectId).toBe(first.projectId);
    expect(second.invocationId).not.toBe(first.invocationId);
  });

  it("selects one root package manager and hashes its lockfile", async () => {
    const project = await temporaryProject();
    await expect(inspectProject(project)).resolves.toMatchObject({
      packageManager: "npm",
      lockfile: "package-lock.json",
      declaredPackageManager: null,
    });
  });

  it("installs into the masked dependency directory and records reproducibility state", async () => {
    const project = await temporaryProject();
    const dependencies = join(project, "container-dependencies");
    await mkdir(dependencies);
    const plan = await prepareProject(project, dependencies);
    const state = JSON.parse(await readFile(join(dependencies, ".route-agent-state.json"), "utf8")) as {
      lockHash: string;
      runtimeIdentity: string;
      packageManager: string;
    };
    expect(state.lockHash).toBe(plan.lockHash);
    expect(state.runtimeIdentity).toContain(process.versions.modules);
    expect(state.packageManager).toMatch(/^npm@/);
    await writeFile(join(project, "package-lock.json"), `${await readFile(join(project, "package-lock.json"), "utf8")}\n`);
    const updated = await prepareProject(project, dependencies);
    expect(updated.lockHash).not.toBe(plan.lockHash);
    const updatedState = JSON.parse(
      await readFile(join(dependencies, ".route-agent-state.json"), "utf8"),
    ) as { lockHash: string };
    expect(updatedState.lockHash).toBe(updated.lockHash);
  });

  it("rejects missing, ambiguous, and manager-mismatched lockfiles", async () => {
    const project = await temporaryProject();
    await rm(join(project, "package-lock.json"));
    await expect(inspectProject(project)).rejects.toThrow(/exactly one supported root lockfile/);
    await writeFile(join(project, "package-lock.json"), "{}\n");
    await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await expect(inspectProject(project)).rejects.toThrow(/ambiguous/);
    await rm(join(project, "pnpm-lock.yaml"));
    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify({ name: "phase03-fixture", packageManager: "pnpm@10.18.3" })}\n`,
    );
    await expect(inspectProject(project)).rejects.toThrow(/declares pnpm/);
  });

  it("rejects nested workspace layouts and unsafe host identities", async () => {
    const project = await temporaryProject();
    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify({ name: "phase03-fixture", workspaces: ["packages/*"] })}\n`,
    );
    await expect(inspectProject(project)).rejects.toThrow(/Nested workspace/);
    expect(() => identifyProject("/tmp/project:bad")).toThrow(/neither newlines nor ':'/);
    expect(() => identifyProject("/tmp/project\nbad")).toThrow(/neither newlines nor ':'/);
  });
});
