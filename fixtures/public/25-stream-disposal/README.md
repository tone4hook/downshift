# Stream Disposal

Repair the event subscription adapter. Delivery must stop after disposal, unsubscribe must run exactly once, and pending next() calls must resolve as done when disposed. Queued values retain order while active. Repeated dispose is safe. Preserve createQueue and subscribeStream APIs.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
