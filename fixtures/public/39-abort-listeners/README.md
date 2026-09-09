# Abort Listeners

Fix cancellable sleep using an injected scheduler. An already-aborted signal must reject with the exact abort reason and schedule nothing. On later abort, cancel the timer and reject; on timer completion, remove the abort listener and resolve. Settle once, clean up listeners in both paths, and support abort reasons such as 0. Preserve sleepWithSignal and attachAbort APIs.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
