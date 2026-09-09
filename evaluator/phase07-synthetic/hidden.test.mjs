import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/sum-positive.ts`).href;
const { sumPositive } = await import(modulePath);

test("handles empty and all-negative inputs without mutating the caller", () => {
  const values = [-7, -2, 0];
  assert.equal(sumPositive([]), 0);
  assert.equal(sumPositive(values), 0);
  assert.deepEqual(values, [-7, -2, 0]);
});

test("preserves fractional positive values", () => {
  assert.equal(sumPositive([0.25, -3, 1.75]), 2);
});

// PHASE07_HIDDEN_SENTINEL
