import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../src/config.ts";

test("applies ordinary file and environment overrides", () => {
  assert.deepEqual(resolveConfig(
    { retries: 1, timeoutMs: 100, verbose: false },
    { retries: 2 },
    { LAB_TIMEOUT_MS: "250", LAB_VERBOSE: "true" },
  ), { retries: 2, timeoutMs: 250, verbose: true });
});
