# Create-item validation

Implement
`validateCreate(input: unknown): ValidationResult<{ title: string; quantity: number }>`
in `src/create.ts`.

- Accept only object input with a string title and numeric quantity.
- Trim the title and require 1-80 characters.
- Require an integer quantity from 1 through 100 without coercion.
- Accumulate useful nonempty errors for both invalid fields.
- Preserve valid normalized output and do not mutate input.
