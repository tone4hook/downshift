export interface TransactionView {
  getBalance(id: string): Promise<number | null>;
  setBalance(id: string, cents: number): Promise<void>;
}

export interface TransferRepository extends TransactionView {
  transaction<T>(work: (view: TransactionView) => Promise<T>): Promise<T>;
}

function codedError(code: string): Error {
  return new Error(code);
}

export async function transfer(
  repo: TransferRepository,
  fromId: string,
  toId: string,
  cents: number,
): Promise<void> {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw codedError("INVALID_AMOUNT");
  if (fromId === toId) throw codedError("SAME_ACCOUNT");
  await repo.transaction(async (view) => {
    const from = await view.getBalance(fromId);
    const to = await view.getBalance(toId);
    if (from === null || to === null) throw codedError("NOT_FOUND");
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < cents) {
      throw codedError(from < cents ? "INSUFFICIENT_FUNDS" : "INVALID_AMOUNT");
    }
    const destination = to + cents;
    if (!Number.isSafeInteger(destination)) throw codedError("INVALID_AMOUNT");
    await view.setBalance(fromId, from - cents);
    await view.setBalance(toId, destination);
  });
}
