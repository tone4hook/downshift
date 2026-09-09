import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/batch.ts`).href;
const { runBatch } = await import(modulePath);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("bounds concurrency and preserves result order", async () => {
  const pending = [];
  let active = 0;
  let maximum = 0;
  const tasks = Array.from({ length: 4 }, (_, index) => async () => {
    active++;
    maximum = Math.max(maximum, active);
    const item = deferred();
    pending.push({ ...item, index });
    const value = await item.promise;
    active--;
    return value;
  });
  const result = runBatch(tasks, 2, new AbortController().signal);
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[1].resolve("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 3);
  pending[0].resolve("first");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 4);
  pending[3].resolve("fourth");
  pending[2].resolve("third");
  assert.deepEqual(await result, ["first", "second", "third", "fourth"]);
  assert.equal(maximum, 2);
});

test("abort stops scheduling and waits for running tasks", async () => {
  const controller = new AbortController();
  const pending = [];
  let started = 0;
  const tasks = Array.from({ length: 4 }, () => async () => {
    started++;
    const item = deferred();
    pending.push(item);
    return item.promise;
  });
  const result = runBatch(tasks, 2, controller.signal);
  await Promise.resolve();
  controller.abort();
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });
  pending[0].resolve("done");
  await new Promise((resolve) => setImmediate(resolve));
  if (started === 2) assert.equal(settled, false);
  for (const item of pending.slice(1)) item.resolve("done");
  await assert.rejects(result, (error) => error.name === "AbortError");
  assert.equal(started, 2);
});

test("the first terminal cause wins and invalid input starts nothing", async () => {
  let called = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runBatch([async () => { called++; return "unused"; }], 1, controller.signal),
    (error) => error.name === "AbortError",
  );
  assert.equal(called, 0);
  for (const concurrency of [0, -1, 1.5]) {
    await assert.rejects(
      runBatch([async () => { called++; return "unused"; }], concurrency, new AbortController().signal),
      RangeError,
    );
  }
  assert.equal(called, 0);

  const failure = new Error("first failure");
  const pending = deferred();
  const tasks = [
    async () => { throw failure; },
    async () => pending.promise,
    async () => "must not start",
  ];
  const result = runBatch(tasks, 2, new AbortController().signal);
  await Promise.resolve();
  pending.resolve("settled");
  await assert.rejects(result, (error) => error === failure);
});

test("preserves the first failure-or-abort cause and removes listeners", async () => {
  for (const firstCause of ["failure", "abort"]) {
    const controller = new AbortController();
    const first = deferred();
    const second = deferred();
    const failure = new Error("task failed first");
    const result = runBatch(
      [async () => first.promise, async () => second.promise],
      2,
      controller.signal,
    );
    await Promise.resolve();
    if (firstCause === "failure") {
      first.reject(failure);
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
    } else {
      controller.abort();
      first.reject(failure);
    }
    second.resolve("settled");
    await assert.rejects(
      result,
      firstCause === "failure"
        ? (error) => error === failure
        : (error) => error.name === "AbortError",
    );
  }

  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener() { added++; },
    removeEventListener() { removed++; },
  };
  assert.deepEqual(await runBatch([], 1, signal), []);
  assert.equal(added, 1);
  assert.equal(removed, 1);
});
