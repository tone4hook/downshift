export interface Line {
  unitCents: number;
  quantity: number;
}

export function calculateTotal(lines: Line[], discountPercent: number): number {
  return lines.reduce(
    (total, line) =>
      total + Math.round(line.unitCents * line.quantity * (100 - discountPercent) / 100),
    0,
  );
}
