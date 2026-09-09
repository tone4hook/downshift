import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/retry.ts`).href;
const { retry } = await import(modulePath);

test("uses one-based bounded attempts and delays only between them", async () => {
  const attempts = [];
  const delays = [];
  const result = await retry(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 3) throw new Error(`retry-${attempt}`);
    return "done";
  }, {
    maxAttempts: 3,
    delay: async (attempt) => delays.push(attempt),
    shouldRetry: () => true,
  });
  assert.equal(result, "done");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [1, 2]);
});

test("propagates terminal causes unchanged", async () => {
  const terminal = new Error("terminal");
  const attempts = [];
  await assert.rejects(retry(async (attempt) => {
    attempts.push(attempt);
    throw terminal;
  }, {
    maxAttempts: 2,
    delay: async () => {},
    shouldRetry: () => true,
  }), (error) => error === terminal);
  assert.deepEqual(attempts, [1, 2]);

  const blocked = new Error("do not retry");
  let delayed = false;
  await assert.rejects(retry(async () => {
    throw blocked;
  }, {
    maxAttempts: 3,
    delay: async () => { delayed = true; },
    shouldRetry: () => false,
  }), (error) => error === blocked);
  assert.equal(delayed, false);

  const delayFailure = new Error("delay failed");
  await assert.rejects(retry(async () => {
    throw new Error("operation");
  }, {
    maxAttempts: 3,
    delay: async () => { throw delayFailure; },
    shouldRetry: () => true,
  }), (error) => error === delayFailure);
});

test("rejects invalid limits before calling the operation", async () => {
  for (const maxAttempts of [0, -1, 1.5]) {
    let called = false;
    await assert.rejects(retry(async () => {
      called = true;
      return "unused";
    }, {
      maxAttempts,
      delay: async () => {},
      shouldRetry: () => true,
    }), RangeError);
    assert.equal(called, false);
  }
});
