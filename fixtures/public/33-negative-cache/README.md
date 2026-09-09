# Negative Cache

Fix directory lookup caching. Cache a successful missing lookup (null) for the supplied TTL just like a found record; never cache exceptions. Expire entries when now >= expiresAt using the injected clock. Each key is independent. Preserve createExpiringCache and createDirectory APIs and reject negative or nonfinite TTL with INVALID_TTL.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
