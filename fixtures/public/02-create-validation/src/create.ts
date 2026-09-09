export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string[]> };

export interface CreateItem {
  title: string;
  quantity: number;
}

export function validateCreate(input: unknown): ValidationResult<CreateItem> {
  const value = input as CreateItem;
  return {
    ok: true,
    value: {
      title: value.title.trim(),
      quantity: value.quantity,
    },
  };
}
