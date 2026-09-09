import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/items.ts`).href;
const { createItemService } = await import(modulePath);

const records = [
  { id: "z", title: "Other tenant", status: "active", quantity: 9, tenantId: "two" },
  { id: "b", title: "Beta match", status: "active", quantity: 2, tenantId: "one" },
  { id: "A", title: "MATCH alpha", status: "active", quantity: 1, tenantId: "one" },
  { id: "c", title: "Match archived", status: "archived", quantity: 3, tenantId: "one" },
  { id: "d", title: "No result", status: "active", quantity: 4, tenantId: "one" },
];

test("filters before count and pagination without tenant leakage", () => {
  const snapshot = structuredClone(records);
  const service = createItemService({ list: () => records });
  assert.deepEqual(service.listItems(
    { page: "1", pageSize: "1", text: " match ", status: "active" },
    { tenantId: "one" },
  ), {
    items: [{ id: "A", title: "MATCH alpha", status: "active", quantity: 1 }],
    total: 2,
    page: 1,
    pageSize: 1,
  });
  assert.deepEqual(service.listItems(
    { page: "3", pageSize: "1", text: "match", status: "active" },
    { tenantId: "one" },
  ), { items: [], total: 2, page: 3, pageSize: 1 });
  assert.deepEqual(records, snapshot);
});

test("sorts by code-point ID and applies defaults", () => {
  const service = createItemService({ list: () => records });
  const result = service.listItems({}, { tenantId: "one" });
  assert.deepEqual(result.items.map((item) => item.id), ["A", "b", "c", "d"]);
  assert.equal(result.total, 4);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 20);
  assert.equal(result.items.some((item) => "tenantId" in item), false);
});

test("rejects invalid queries with a stable code", () => {
  const service = createItemService({ list: () => records });
  for (const request of [
    { page: "0" },
    { page: "1.5" },
    { page: " 1" },
    { pageSize: "0" },
    { pageSize: "101" },
    { status: "deleted" },
  ]) {
    assert.throws(
      () => service.listItems(request, { tenantId: "one" }),
      (error) => error.message === "INVALID_QUERY",
    );
  }
});
