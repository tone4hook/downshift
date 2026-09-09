# Customer display name

Implement `displayName(customer: { name?: string | null }): string` in
`src/customer.ts`.

- Return `Unknown customer` when the name is missing, empty, or whitespace.
- Trim nonblank names before returning them.
- Do not mutate the input customer.
