import assert from "node:assert/strict";
import test from "node:test";
import { retry } from "../src/retry.ts";

test("returns a successful first attempt", async () => {
  const attempts = [];
  const result = await retry(async (attempt) => {
    attempts.push(attempt);
    return "done";
  }, { maxAttempts: 3, delay: async () => {}, shouldRetry: () => true });
  assert.equal(result, "done");
  assert.deepEqual(attempts, [1]);
});
