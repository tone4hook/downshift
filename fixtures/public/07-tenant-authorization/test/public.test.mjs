import assert from "node:assert/strict";
import test from "node:test";
import { canEdit } from "../src/authorization.ts";

test("allows same-tenant owners and administrators", () => {
  assert.equal(canEdit(
    { id: "owner", role: "member", tenantId: "tenant-a" },
    { ownerId: "owner", tenantId: "tenant-a" },
  ), true);
  assert.equal(canEdit(
    { id: "admin", role: "admin", tenantId: "tenant-a" },
    { ownerId: "owner", tenantId: "tenant-a" },
  ), true);
});
