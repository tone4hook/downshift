# Cancelable batch

Implement `runBatch(tasks, concurrency, signal)` in `src/batch.ts`.

- Require a positive integer concurrency and preserve input result order.
- Never exceed the concurrency limit.
- Once aborted, start no new tasks, wait for running tasks, then reject with an
  error named `AbortError`.
- A task failure also stops scheduling, waits for running tasks, and rejects
  with the first observed failure.
- The first observed failure or abort wins, abort listeners are removed on
  settlement, and an already-aborted signal starts no tasks.
