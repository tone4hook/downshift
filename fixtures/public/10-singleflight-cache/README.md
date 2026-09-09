# Single-flight cache

Implement `createCache(load, now, ttlMs).get(key)` in `src/cache.ts`.

- Require a positive finite TTL at construction.
- Coalesce concurrent loads for the same key while keeping keys independent.
- Cache successful values only; failures clear pending state and are not cached.
- Start the TTL when a load fulfills and expire when `now() >= expiresAt`.
- Cached values are returned through a promise.
