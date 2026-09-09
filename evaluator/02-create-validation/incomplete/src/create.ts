export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string[]> };

export interface CreateItem {
  title: string;
  quantity: number;
}

export function validateCreate(input: unknown): ValidationResult<CreateItem> {
  const value = input as CreateItem;
  const errors: Record<string, string[]> = {};
  if (!value.title) errors.title = ["Title is required."];
  if (!value.quantity || value.quantity < 1 || value.quantity > 100) {
    errors.quantity = ["Quantity must be between 1 and 100."];
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, value: { title: value.title.trim(), quantity: value.quantity } };
}
