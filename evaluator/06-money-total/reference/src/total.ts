export interface Line {
  unitCents: number;
  quantity: number;
}

export function calculateTotal(lines: Line[], discountPercent: number): number {
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new RangeError("Discount must be an integer from 0 through 100.");
  }
  let subtotal = 0;
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.unitCents) ||
      line.unitCents < 0 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 0
    ) {
      throw new RangeError("Line values must be nonnegative safe integers.");
    }
    const lineTotal = line.unitCents * line.quantity;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotal + lineTotal)) {
      throw new RangeError("Total exceeds the safe integer range.");
    }
    subtotal += lineTotal;
  }
  const total = Number(
    (BigInt(subtotal) * BigInt(100 - discountPercent) + 50n) / 100n,
  );
  if (!Number.isSafeInteger(total)) throw new RangeError("Total exceeds the safe integer range.");
  return total;
}
