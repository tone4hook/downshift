import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Collect only this stopped agent's local evidence, never directories or links. */
export async function collectAttempt(source: string, destination: string): Promise<void> {
  const parent = await lstat(dirname(source)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!parent) return;
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Invalid attempt output parent");
  const directory = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!directory) return;
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid attempt output directory");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of ["events.jsonl", "patch.diff", "run.json"]) {
    const file = await open(join(source, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!file) continue;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error(`Invalid attempt artifact: ${name}`);
      const target = join(destination, name);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const output = await open(temporary, "wx", 0o600);
      try { await output.writeFile(await file.readFile()); await output.sync(); }
      finally { await output.close(); }
      await rename(temporary, target);
    } finally { await file.close(); }
  }
}
