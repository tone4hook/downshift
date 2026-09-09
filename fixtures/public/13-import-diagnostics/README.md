# Import diagnostics

Implement `importRows(rows, existingIds)` in `src/import.ts`.

- Accept trimmed, nonempty string IDs and titles no longer than 80 characters.
- IDs are case-sensitive and cannot duplicate an existing ID or earlier accepted row.
- A rejected row does not reserve its ID.
- Return every valid normalized row in order and every invalid row as
  `{ row, fields }`, with zero-based row indices and alphabetically sorted field keys.
- Report all invalid rows and do not mutate inputs.
