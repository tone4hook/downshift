export interface Line {
  unitCents: number;
  quantity: number;
}

export function calculateTotal(lines: Line[], discountPercent: number): number {
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new RangeError("Discount must be an integer from 0 through 100.");
  }
  let total = 0;
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.unitCents) ||
      line.unitCents < 0 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 0
    ) {
      throw new RangeError("Line values must be nonnegative safe integers.");
    }
    const discounted = Math.round(
      line.unitCents * line.quantity * (100 - discountPercent) / 100,
    );
    if (!Number.isSafeInteger(discounted) || !Number.isSafeInteger(total + discounted)) {
      throw new RangeError("Total exceeds the safe integer range.");
    }
    total += discounted;
  }
  return total;
}
