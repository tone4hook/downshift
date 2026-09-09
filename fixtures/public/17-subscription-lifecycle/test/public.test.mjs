import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.ts";

test("stores values and supports unsubscribe", () => {
  const store = createStore(0);
  const seen = [];
  const unsubscribe = store.subscribe((value) => seen.push(value));
  store.set(1);
  unsubscribe();
  store.set(2);
  assert.equal(store.get(), 2);
  assert.deepEqual(seen, [1]);
});
