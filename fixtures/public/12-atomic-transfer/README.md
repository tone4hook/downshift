# Atomic transfer

Implement `transfer(repo, fromId, toId, cents): Promise<void>` in
`src/transfer.ts`.

- Validate in this order: positive safe-integer amount (`INVALID_AMOUNT`),
  distinct accounts (`SAME_ACCOUNT`), both accounts exist (`NOT_FOUND`), then
  sufficient funds (`INSUFFICIENT_FUNDS`).
- Read and write both balances inside one `repo.transaction` callback.
- Commit only if the callback fulfills; storage errors propagate unchanged.
- Preserve a safe-integer total and use no real database.
