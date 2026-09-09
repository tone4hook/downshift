export function sumPositive(values: number[]): number {
  return values.reduce((total, value) => (value > 0 ? total + value : total), 0);
}
