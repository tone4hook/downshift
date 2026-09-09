# Tenant authorization

Fix `canEdit(user, record)` in `src/authorization.ts`.

- Access is allowed only within the user's tenant.
- Within that tenant, administrators and the record owner may edit.
- All cross-tenant access is denied, including administrators and matching owner IDs.
- Do not mutate either input.
