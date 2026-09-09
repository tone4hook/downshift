# Resource Stack

Repair the resource stack used by session setup. Dispose registered resources in reverse acquisition order, continue disposing after errors, and reject with an AggregateError containing errors in disposal order. Disposal must be idempotent, and registrations after disposal begins must throw CLOSED. If setup fails after acquiring resources, run cleanup before rethrowing the setup error; preserve that error when cleanup succeeds.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
