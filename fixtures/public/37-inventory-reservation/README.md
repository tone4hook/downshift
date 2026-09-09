# Inventory Reservation

Fix reservation idempotency and atomicity. A repeated requestId with identical SKU and quantity returns the prior reservation without charging inventory again. Reusing the ID with different input throws IDEMPOTENCY_CONFLICT. Positive safe-integer quantities only. Within one transaction, check the request, check stock, decrement it, and store the reservation; failed storage rolls back all changes.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
