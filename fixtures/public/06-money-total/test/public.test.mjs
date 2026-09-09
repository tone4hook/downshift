import assert from "node:assert/strict";
import test from "node:test";
import { calculateTotal } from "../src/total.ts";

test("calculates ordinary totals without mutating lines", () => {
  const lines = [
    { unitCents: 250, quantity: 2 },
    { unitCents: 125, quantity: 4 },
  ];
  assert.equal(calculateTotal(lines, 10), 900);
  assert.deepEqual(lines, [
    { unitCents: 250, quantity: 2 },
    { unitCents: 125, quantity: 4 },
  ]);
});
