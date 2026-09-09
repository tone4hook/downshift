# Pagination boundaries

Implement
`paginate<T>(rows: T[], page: number, pageSize: number): { items: T[]; total: number; pageCount: number }`
in `src/paginate.ts`.

- Treat `page` as one-based.
- Require positive integer values for `page` and `pageSize`; throw `RangeError` otherwise.
- Return an empty `items` array for pages past the end.
- Return `pageCount: 0` when there are no rows; otherwise round page count up.
- Preserve row order and do not mutate the input array.
