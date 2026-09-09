# Bulk Authorization

Fix bulk deletion of tenant records. Deduplicate requested IDs in first-seen order; load and authorize the entire set before deleting anything. Missing records yield NOT_FOUND. Tenant mismatch or non-owner access by non-admins yields FORBIDDEN. Administrators remain tenant-scoped. Empty requests return zero without calling storage. Delete once with the deduplicated IDs.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
