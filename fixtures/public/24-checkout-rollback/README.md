# Checkout Rollback

Fix checkout so line items with the same SKU aggregate before stock validation, reject nonpositive or unsafe quantities with INVALID_QUANTITY, and perform stock updates plus order creation inside one transaction. A failed order write must roll back stock. Return the created order and propagate storage errors. Inputs must not be mutated.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
