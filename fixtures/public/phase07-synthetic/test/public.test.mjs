import assert from "node:assert/strict";
import test from "node:test";
import { sumPositive } from "../src/sum-positive.ts";

test("sums positive values while ignoring negatives", () => {
  assert.equal(sumPositive([2, -10, 3]), 5);
});
