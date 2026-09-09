# Idempotent events

Implement `applyEvents(initial, events)` in `src/events.ts`.

- Ignore an already-seen event ID before validating its version or payload.
- Every new event must have version exactly `current.version + 1`.
- Support `increment` and `decrement` with positive safe-integer amounts.
- Reject unknown event types, version gaps, and unsafe results.
- Return a new state and `seenIds` array without mutating inputs; replay is stable.
