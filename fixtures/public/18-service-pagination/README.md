# Tenant-scoped service pagination

Implement `createItemService(repo).listItems(request, user)` in `src/items.ts`.

- Parse optional string query fields with defaults page 1 and pageSize 20.
- Page and pageSize are decimal positive integers; pageSize is at most 100.
- Status is absent, `active`, or `archived`; invalid input throws `INVALID_QUERY`.
- Filter repository records by `user.tenantId`, optional status, and a trimmed
  case-insensitive title substring before counting and paginating.
- Sort by ID using code-point order, return the filtered total, and omit tenantId.
- Past-end pages are empty and inputs/repository records are not mutated.
