# Error Contract

Unify the request client error contract. Decode successful 204 responses as null without parsing JSON. For non-2xx responses, throw RequestError with status, code (body.code or HTTP_ERROR), and retryable true only for 429 or 5xx. A malformed error body must still produce RequestError. Preserve the original transport exception and avoid retrying requests.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
