import assert from "node:assert/strict";
import test from "node:test";
import { mapResult } from "../src/result.ts";

test("maps successful values and preserves errors", () => {
  assert.deepEqual(mapResult({ ok: true, value: "bolt" }, (value) => value.length), {
    ok: true,
    value: 4,
  });
  assert.deepEqual(mapResult({ ok: false, error: "missing" }, () => 1), {
    ok: false,
    error: "missing",
  });
});
