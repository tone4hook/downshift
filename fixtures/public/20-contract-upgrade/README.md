# Contract Upgrade

Upgrade the account client to read both v1 {id,name} and v2 {account:{id,displayName}} responses. Normalize names to trimmed displayName strings, keep the stable {id,displayName} output, reject missing IDs with INVALID_ACCOUNT, and URL-encode identifiers when calling transport. Fetch must not mutate transport payloads.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
