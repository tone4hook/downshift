export interface TransactionView {
  getBalance(id: string): Promise<number | null>;
  setBalance(id: string, cents: number): Promise<void>;
}

export interface TransferRepository extends TransactionView {
  transaction<T>(work: (view: TransactionView) => Promise<T>): Promise<T>;
}

export async function transfer(
  repo: TransferRepository,
  fromId: string,
  toId: string,
  cents: number,
): Promise<void> {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("INVALID_AMOUNT");
  if (fromId === toId) throw new Error("SAME_ACCOUNT");
  const from = await repo.getBalance(fromId);
  const to = await repo.getBalance(toId);
  if (from === null || to === null) throw new Error("NOT_FOUND");
  if (from < cents) throw new Error("INSUFFICIENT_FUNDS");
  await repo.setBalance(fromId, from - cents);
  await repo.setBalance(toId, to + cents);
}
