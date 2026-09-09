import assert from "node:assert/strict";
import test from "node:test";
import { paginate } from "../src/paginate.ts";

test("returns a one-based page without mutating rows", () => {
  const rows = ["a", "b", "c", "d"];
  assert.deepEqual(paginate(rows, 1, 2), {
    items: ["a", "b"],
    total: 4,
    pageCount: 2,
  });
  assert.deepEqual(rows, ["a", "b", "c", "d"]);
});
