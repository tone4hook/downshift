import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/result.ts`).href;
const { mapResult } = await import(modulePath);

test("does not call the mapper for errors or mutate inputs", () => {
  const input = { ok: false, error: "denied" };
  let calls = 0;
  assert.deepEqual(mapResult(input, () => {
    calls += 1;
    return 1;
  }), input);
  assert.equal(calls, 0);
  assert.deepEqual(input, { ok: false, error: "denied" });
});

test("propagates mapper exceptions", () => {
  const failure = new Error("mapper failed");
  assert.throws(
    () => mapResult({ ok: true, value: 1 }, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});
