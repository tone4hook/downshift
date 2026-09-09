import { createHash } from "node:crypto";
import { open, rename, readFile, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}

/** Hash only build/test inputs, never credentials, local config, artifacts, or Git metadata. */
export async function sourceContentHash(root: string): Promise<string> {
  const files: Array<[string, string]> = [];
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Source input cannot be a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (["node_modules", "target", ".cache", ".DS_Store"].includes(name)) continue;
        await visit(`${relative}/${name}`);
      }
    } else if (stat.isFile()) files.push([relative, sha(await readFile(path))]);
  }
  for (const path of ["Dockerfile", ".dockerignore", "docker", "compose.yaml", "route-agent", "package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.build.json", "config/upstream-lock.json", "rust/switchyard-bridge/Cargo.toml", "rust/switchyard-bridge/Cargo.lock", "rust/switchyard-bridge/src", "src", "tests", "scripts", "tasks", "fixtures/public", "evaluator"]) await visit(path);
  return digest(files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has unexpected or missing fields`);
}
export function markdown(value: unknown): string { return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[|`<>]/g, (c) => `\\${c}`); }
