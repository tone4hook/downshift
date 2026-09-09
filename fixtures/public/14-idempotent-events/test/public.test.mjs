import assert from "node:assert/strict";
import test from "node:test";
import { applyEvents } from "../src/events.ts";

test("applies an ordered event", () => {
  assert.deepEqual(applyEvents(
    { value: 1, version: 0, seenIds: [] },
    [{ id: "e1", version: 1, type: "increment", amount: 2 }],
  ), { value: 3, version: 1, seenIds: ["e1"] });
});
