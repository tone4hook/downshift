export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string[]> };

export interface CreateItem {
  title: string;
  quantity: number;
}

export function validateCreate(input: unknown): ValidationResult<CreateItem> {
  const record =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const quantity = record.quantity;
  const errors: Record<string, string[]> = {};
  if (title.length < 1 || title.length > 80) {
    errors.title = ["Title must contain between 1 and 80 characters."];
  }
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    errors.quantity = ["Quantity must be an integer between 1 and 100."];
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, value: { title, quantity: quantity as number } };
}
