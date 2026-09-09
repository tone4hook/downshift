import assert from "node:assert/strict";
import test from "node:test";
import { createCache } from "../src/cache.ts";

test("caches a successful value before expiry", async () => {
  let calls = 0;
  const cache = createCache(async () => `value-${++calls}`, () => 10, 100);
  assert.equal(await cache.get("a"), "value-1");
  assert.equal(await cache.get("a"), "value-1");
  assert.equal(calls, 1);
});
