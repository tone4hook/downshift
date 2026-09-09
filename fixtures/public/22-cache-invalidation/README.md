# Cache Invalidation

The user service caches lookups by tenant and user ID. Fix tenant isolation and invalidate only that user after a successful write. Failed writes must preserve cached data. Cache undefined as a legitimate result and do not expose mutable cache storage. Preserve createCache and createUserService interfaces.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
