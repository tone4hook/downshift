import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/items.ts`).href;
const { filterItems } = await import(modulePath);

const items = [
  { id: "1", title: "Blue Bolt", status: "active", quantity: 1 },
  { id: "2", title: "Red bolt", status: "archived", quantity: 2 },
  { id: "3", title: "Blue Washer", status: "active", quantity: 3 },
];

test("filters text case-insensitively and treats blank text as absent", () => {
  assert.deepEqual(filterItems(items, { text: " BOLT " }).map(({ id }) => id), ["1", "2"]);
  assert.deepEqual(filterItems(items, { text: "  " }).map(({ id }) => id), ["1", "2", "3"]);
});

test("combines text and status with AND and returns empty for no match", () => {
  assert.deepEqual(
    filterItems(items, { text: "blue", status: "active" }).map(({ id }) => id),
    ["1", "3"],
  );
  assert.deepEqual(filterItems(items, { text: "blue", status: "archived" }), []);
});

test("keeps stable order and does not mutate inputs", () => {
  const before = structuredClone(items);
  const result = filterItems(items, { status: "active" });
  assert.deepEqual(result.map(({ id }) => id), ["1", "3"]);
  assert.deepEqual(items, before);
  assert.notEqual(result, items);
});
