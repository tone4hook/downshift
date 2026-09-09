# Retry Worker

Fix the delivery worker retry contract. Retry only errors whose retryable field is true, up to maxAttempts total calls (a positive integer). Use injected sleep with delays baseDelay * 2^attemptIndex starting after the first failure. Do not sleep after the final failure or after success. Preserve the last error identity. Record each attempted delivery number starting at 1.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
