import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/store.ts`).href;
const { createStore } = await import(modulePath);

test("treats subscriptions distinctly and snapshots each dispatch", () => {
  const store = createStore(0);
  const seen = [];
  const listener = (value) => seen.push(`same:${value}`);
  const first = store.subscribe(listener);
  const second = store.subscribe(listener);
  let unsubscribeLate = () => {};
  store.subscribe((value) => {
    seen.push(`manager:${value}`);
    if (value === 1) {
      first();
      first();
      unsubscribeLate = store.subscribe((next) => seen.push(`late:${next}`));
    }
  });
  store.set(1);
  store.set(2);
  second();
  unsubscribeLate();
  store.set(2);
  assert.deepEqual(seen, [
    "same:1", "same:1", "manager:1",
    "same:2", "manager:2", "late:2",
    "manager:2",
  ]);
});

test("queues reentrant sets and propagates the first error after draining", () => {
  const store = createStore(0);
  const seen = [];
  const firstError = new Error("first");
  store.subscribe((value) => {
    seen.push(`a:${value}`);
    if (value === 1) store.set(2);
    if (value === 1) throw firstError;
  });
  store.subscribe((value) => {
    seen.push(`b:${value}`);
    if (value === 2) store.set(3);
    if (value === 2) throw new Error("second");
  });
  assert.throws(() => store.set(1), (error) => error === firstError);
  assert.deepEqual(seen, ["a:1", "b:1", "a:2", "b:2", "a:3", "b:3"]);
  assert.equal(store.get(), 3);
});
