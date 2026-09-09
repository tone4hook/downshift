import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(
  `${process.env.LAB_SUBMISSION_ROOT}/src/authorization.ts`,
).href;
const { canEdit } = await import(modulePath);

test("denies every cross-tenant edit and unrelated same-tenant members", () => {
  assert.equal(canEdit(
    { id: "admin", role: "admin", tenantId: "tenant-a" },
    { ownerId: "someone", tenantId: "tenant-b" },
  ), false);
  assert.equal(canEdit(
    { id: "owner", role: "member", tenantId: "tenant-a" },
    { ownerId: "owner", tenantId: "tenant-b" },
  ), false);
  assert.equal(canEdit(
    { id: "member", role: "member", tenantId: "tenant-a" },
    { ownerId: "owner", tenantId: "tenant-a" },
  ), false);
});

test("does not mutate inputs", () => {
  const user = Object.freeze({ id: "owner", role: "member", tenantId: "tenant-a" });
  const record = Object.freeze({ ownerId: "owner", tenantId: "tenant-a" });
  assert.equal(canEdit(user, record), true);
  assert.deepEqual(user, { id: "owner", role: "member", tenantId: "tenant-a" });
  assert.deepEqual(record, { ownerId: "owner", tenantId: "tenant-a" });
});
