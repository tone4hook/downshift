import assert from "node:assert/strict";
import test from "node:test";
import { filterItems } from "../src/items.ts";

test("an empty query preserves item order", () => {
  const items = [
    { id: "b", title: "Bolts", status: "active", quantity: 3 },
    { id: "a", title: "Washers", status: "archived", quantity: 8 },
  ];
  assert.deepEqual(filterItems(items, {}), items);
});
