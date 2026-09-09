# Event Outbox

Repair user rename and outbox creation. Trim and validate names (1..80 characters), then update the user and append a user.renamed event in the same transaction. The event must contain userId and the normalized name but no email or passwordHash. Missing users yield NOT_FOUND; failed event insertion rolls back the rename. An unchanged normalized name performs neither write.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
