import assert from "node:assert/strict";
import test from "node:test";
import { displayName } from "../src/customer.ts";

test("preserves and trims a real customer name", () => {
  assert.equal(displayName({ name: "  Ada Lovelace  " }), "Ada Lovelace");
});
