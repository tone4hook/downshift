# Stable item filtering

Implement
`filterItems(items: Item[], query: { text?: string; status?: Item["status"] }): Item[]`
in `src/items.ts`.

- Match trimmed text case-insensitively against title substrings.
- Treat missing or blank text as matching every title.
- Combine optional text and status filters with AND.
- Preserve input order, do not mutate input, and return an empty array when
  nothing matches.
