export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function mapResult<A, B>(
  result: Result<A>,
  mapper: (value: any) => any,
): Result<B> {
  if (!result.ok) return result as Result<B>;
  return { ok: true, value: mapper(result.value) };
}
