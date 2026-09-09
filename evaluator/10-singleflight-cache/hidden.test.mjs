import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/cache.ts`).href;
const { createCache } = await import(modulePath);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("coalesces by key and starts TTL when loading finishes", async () => {
  let time = 0;
  const pending = [];
  const calls = [];
  const cache = createCache((key) => {
    calls.push(key);
    const item = deferred();
    pending.push(item);
    return item.promise;
  }, () => time, 10);
  const first = cache.get("a");
  const duplicate = cache.get("a");
  const other = cache.get("b");
  assert.equal(first, duplicate);
  assert.notEqual(first, other);
  assert.deepEqual(calls, ["a", "b"]);
  time = 8;
  pending[0].resolve("A");
  pending[1].resolve("B");
  assert.deepEqual(await Promise.all([first, duplicate, other]), ["A", "A", "B"]);
  time = 17;
  const beforeExpiry = cache.get("a");
  assert.equal(calls.length, 2);
  assert.equal(await beforeExpiry, "A");
  time = 18;
  const expired = cache.get("a");
  assert.equal(calls.length, 3);
  pending[2].resolve("A2");
  assert.equal(await expired, "A2");
});

test("does not cache failures and validates TTL", async () => {
  assert.throws(() => createCache(async () => "x", () => 0, 0), RangeError);
  assert.throws(() => createCache(async () => "x", () => 0, Number.POSITIVE_INFINITY), RangeError);
  let calls = 0;
  const cache = createCache(async () => {
    calls++;
    if (calls === 1) throw new Error("load failed");
    return "recovered";
  }, () => 0, 10);
  await assert.rejects(cache.get("a"), /load failed/);
  assert.equal(await cache.get("a"), "recovered");
  assert.equal(calls, 2);
});
