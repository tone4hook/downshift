import assert from "node:assert/strict";
import test from "node:test";
import { createItemService } from "../src/items.ts";

test("lists a tenant's first page", () => {
  const service = createItemService({
    list: () => [{ id: "a", title: "Alpha", status: "active", quantity: 1, tenantId: "one" }],
  });
  assert.deepEqual(service.listItems({}, { tenantId: "one" }), {
    items: [{ id: "a", title: "Alpha", status: "active", quantity: 1 }],
    total: 1,
    page: 1,
    pageSize: 20,
  });
});
