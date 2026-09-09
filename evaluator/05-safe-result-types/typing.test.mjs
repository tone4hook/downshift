import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "routing-lab-result-types-"));
try {
  const modulePath = `${process.env.LAB_SUBMISSION_ROOT}/src/result.ts`;
  const source = [
    `import { mapResult, type Result } from ${JSON.stringify(modulePath)};`,
    'const input: Result<string> = { ok: true, value: "bolt" };',
    "const mapped = mapResult(input, (value) => value.length);",
    "const numberResult: Result<number> = mapped;",
    "void numberResult;",
    "// @ts-expect-error a string result cannot use a number mapper",
    "mapResult(input, (value: number) => value + 1);",
  ].join("\n");
  const checkPath = join(root, "check.ts");
  await writeFile(checkPath, `${source}\n`);
  const result = spawnSync(process.execPath, [
    process.env.LAB_TYPESCRIPT_BIN,
    "--noEmit",
    "--strict",
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--allowImportingTsExtensions",
    "--skipLibCheck",
    checkPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
