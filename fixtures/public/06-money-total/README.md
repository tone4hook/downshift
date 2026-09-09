# Money total

Implement
`calculateTotal(lines: { unitCents: number; quantity: number }[], discountPercent: number): number`
in `src/total.ts`.

- Require nonnegative safe-integer cents and quantities.
- Require an integer discount from 0 through 100.
- Reject invalid inputs and unsafe intermediate or final totals with `RangeError`.
- Sum the undiscounted line totals, then round the final discounted amount once.
- Return an integer number of cents and do not mutate the input.
