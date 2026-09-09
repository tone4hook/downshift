import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/total.ts`).href;
const { calculateTotal } = await import(modulePath);

test("rounds the final discounted total once", () => {
  assert.equal(calculateTotal([
    { unitCents: 1, quantity: 1 },
    { unitCents: 1, quantity: 1 },
  ], 50), 1);
  assert.equal(calculateTotal([{ unitCents: 101, quantity: 3 }], 25), 227);
  assert.equal(
    calculateTotal([{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 1 }], 6),
    8466767299456532,
  );
});

test("accepts boundary values and preserves input", () => {
  const lines = [{ unitCents: 0, quantity: 0 }, { unitCents: 10, quantity: 2 }];
  assert.equal(calculateTotal(lines, 100), 0);
  assert.deepEqual(lines, [{ unitCents: 0, quantity: 0 }, { unitCents: 10, quantity: 2 }]);
});

test("rejects invalid values and unsafe totals", () => {
  for (const lines of [
    [{ unitCents: -1, quantity: 1 }],
    [{ unitCents: 1.5, quantity: 1 }],
    [{ unitCents: 1, quantity: -1 }],
    [{ unitCents: 1, quantity: 1.5 }],
    [{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 2 }],
  ]) {
    assert.throws(() => calculateTotal(lines, 0), RangeError);
  }
  for (const discount of [-1, 101, 1.5]) {
    assert.throws(() => calculateTotal([], discount), RangeError);
  }
  assert.throws(
    () => calculateTotal([
      { unitCents: Number.MAX_SAFE_INTEGER, quantity: 1 },
      { unitCents: 1, quantity: 1 },
    ], 0),
    RangeError,
  );
});
