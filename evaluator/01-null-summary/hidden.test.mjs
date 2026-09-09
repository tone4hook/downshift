import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/customer.ts`).href;
const { displayName } = await import(modulePath);

test("uses the fallback for missing and blank names", () => {
  for (const name of [null, undefined, "", " \t\n "]) {
    assert.equal(displayName({ name }), "Unknown customer");
  }
});

test("trims nonblank names without mutating the customer", () => {
  const customer = { name: "  Grace Hopper " };
  assert.equal(displayName(customer), "Grace Hopper");
  assert.deepEqual(customer, { name: "  Grace Hopper " });
});
