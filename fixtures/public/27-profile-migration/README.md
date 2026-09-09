# Profile Migration

Upgrade saved profiles from version 1 {name,endpoint} to version 2 {name,connection:{url},enabled}. Preserve false in existing version 2 profiles; default enabled to true only when absent. Load must migrate without changing the stored input; save must persist version 2 and validate an http(s) URL before writing. Reject unknown versions with UNSUPPORTED_VERSION and invalid URLs with INVALID_URL.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
