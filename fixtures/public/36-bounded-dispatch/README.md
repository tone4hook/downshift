# Bounded Dispatch

Repair batch dispatch: run no more than concurrency jobs at once, preserve result order, and return an all-settled result for each input. Continue after individual failures. Reject invalid concurrency before starting any job. An empty batch resolves immediately. Preserve dispatch and validateConcurrency APIs.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
