# Cache Refresh Race

Fix refresh races in the settings store. Every refresh returns its own loaded result, but only the most recently started refresh may update cached state. Keys are independent. A failed latest refresh leaves the last committed value unchanged; an older pending refresh must not overwrite it later. Manual set invalidates all older refreshes for that key.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
