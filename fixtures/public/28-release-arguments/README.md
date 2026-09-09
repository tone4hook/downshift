# Release Arguments

Repair release argument parsing and command construction. Support --tag VALUE and --dry-run only before --; after -- preserve every argument literally for the package manager. Reject unknown options, missing/empty tags, and tag values starting with -- as INVALID_ARGUMENT. Build an argv array for npm publish, never a shell command. Dry runs must not invoke the runner.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
