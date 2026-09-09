# Retry policy

Implement `retry(operation, options)` in `src/retry.ts`.

- `operation` receives one-based attempt numbers and the first call counts.
- `maxAttempts` must be a positive integer and is the total attempt limit.
- Retry only when `shouldRetry(error)` is true and attempts remain.
- Call `delay(failedAttempt)` exactly between attempts.
- Propagate the final operation error or any delay error unchanged.
