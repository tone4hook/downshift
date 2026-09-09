# Shared Link Access

Repair shared link access checks. Reject revoked links and links whose expiresAt is <= the supplied clock. Links grant only their listed resourceId and never expose internalToken. Resolve the link before loading the resource; invalid links must not read resources. Missing resources return NOT_FOUND. All checks use the injected clock, not wall time.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
