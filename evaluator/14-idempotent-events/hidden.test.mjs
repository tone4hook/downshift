import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/events.ts`).href;
const { applyEvents } = await import(modulePath);

test("ignores duplicates first and supports stable replay", () => {
  const initial = { value: 5, version: 1, seenIds: ["e1"] };
  const events = [
    { id: "e1", version: 999, type: "unknown", amount: -1 },
    { id: "e2", version: 2, type: "decrement", amount: 3 },
    { id: "e2", version: 2, type: "decrement", amount: 3 },
    { id: "e3", version: 3, type: "increment", amount: 4 },
  ];
  const result = applyEvents(initial, events);
  assert.deepEqual(result, { value: 6, version: 3, seenIds: ["e1", "e2", "e3"] });
  assert.deepEqual(applyEvents(result, events), result);
  assert.deepEqual(initial, { value: 5, version: 1, seenIds: ["e1"] });
});

test("rejects gaps, invalid events, and unsafe arithmetic", () => {
  const initial = { value: 0, version: 0, seenIds: [] };
  for (const event of [
    { id: "gap", version: 2, type: "increment", amount: 1 },
    { id: "type", version: 1, type: "multiply", amount: 1 },
    { id: "zero", version: 1, type: "increment", amount: 0 },
    { id: "fraction", version: 1, type: "increment", amount: 1.5 },
  ]) {
    assert.throws(() => applyEvents(initial, [event]));
  }
  assert.throws(() => applyEvents(
    { value: Number.MAX_SAFE_INTEGER, version: 0, seenIds: [] },
    [{ id: "overflow", version: 1, type: "increment", amount: 1 }],
  ));
});
