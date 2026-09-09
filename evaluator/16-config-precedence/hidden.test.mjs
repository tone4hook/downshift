import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/config.ts`).href;
const { resolveConfig } = await import(modulePath);

test("preserves falsy overrides and ignores absent environment values", () => {
  const defaults = { retries: 3, timeoutMs: 100, verbose: true };
  const file = { retries: 0, verbose: false };
  const env = { LAB_RETRIES: undefined, LAB_TIMEOUT_MS: "200", OTHER: "ignored" };
  assert.deepEqual(resolveConfig(defaults, file, env), {
    retries: 0,
    timeoutMs: 200,
    verbose: false,
  });
  assert.deepEqual(defaults, { retries: 3, timeoutMs: 100, verbose: true });
  assert.deepEqual(file, { retries: 0, verbose: false });
});

test("accepts explicit zero/false environment values", () => {
  assert.deepEqual(resolveConfig(
    { retries: 3, timeoutMs: 100, verbose: true },
    {},
    { LAB_RETRIES: "0", LAB_VERBOSE: "false" },
  ), { retries: 0, timeoutMs: 100, verbose: false });
});

test("rejects invalid environment and resolved values uniformly", () => {
  const defaults = { retries: 1, timeoutMs: 100, verbose: false };
  for (const env of [
    { LAB_RETRIES: "" },
    { LAB_RETRIES: "-1" },
    { LAB_RETRIES: "1.5" },
    { LAB_TIMEOUT_MS: "0" },
    { LAB_TIMEOUT_MS: " 20" },
    { LAB_VERBOSE: "yes" },
  ]) {
    assert.throws(() => resolveConfig(defaults, {}, env), (error) => error.message === "INVALID_CONFIG");
  }
  assert.throws(
    () => resolveConfig({ retries: -1, timeoutMs: 100, verbose: false }, {}, {}),
    (error) => error.message === "INVALID_CONFIG",
  );
  assert.throws(
    () => resolveConfig(defaults, { timeoutMs: 0 }, {}),
    (error) => error.message === "INVALID_CONFIG",
  );
});
