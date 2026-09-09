import assert from "node:assert/strict";
import test from "node:test";
import { validateCreate } from "../src/create.ts";

test("returns normalized valid input", () => {
  assert.deepEqual(validateCreate({ title: "  bolts  ", quantity: 4 }), {
    ok: true,
    value: { title: "bolts", quantity: 4 },
  });
});
