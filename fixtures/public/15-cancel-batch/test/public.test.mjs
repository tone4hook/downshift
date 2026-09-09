import assert from "node:assert/strict";
import test from "node:test";
import { runBatch } from "../src/batch.ts";

test("returns successful results in input order", async () => {
  const result = await runBatch(
    [async () => "first", async () => "second"],
    2,
    new AbortController().signal,
  );
  assert.deepEqual(result, ["first", "second"]);
});
