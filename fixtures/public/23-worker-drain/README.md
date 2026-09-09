# Worker Drain

Make shutdown of the task worker graceful. Enqueue must reject with CLOSED after shutdown begins; shutdown must wait for every already-started task, including rejected tasks, and remain idempotent. Rejected task results must still reject for callers. The worker must report active count accurately and avoid unhandled rejection branches.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
