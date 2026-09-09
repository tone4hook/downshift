# Subscription lifecycle

Implement `createStore(initial)` in `src/store.ts`.

- `subscribe` does not notify immediately and returns an idempotent unsubscribe.
- Every subscription is distinct, even when the same function is subscribed twice.
- Every `set`, including an equal value, notifies each active subscription once.
- Listener changes during a dispatch affect the next dispatch.
- Reentrant sets run FIFO after the current notification completes.
- After all listeners and queued notifications run, propagate the first listener error.
