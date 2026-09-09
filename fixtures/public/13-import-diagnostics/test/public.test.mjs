import assert from "node:assert/strict";
import test from "node:test";
import { importRows } from "../src/import.ts";

test("normalizes valid rows", () => {
  assert.deepEqual(importRows([{ id: " a ", title: " First " }], new Set()), {
    accepted: [{ id: "a", title: "First" }],
    errors: [],
  });
});
