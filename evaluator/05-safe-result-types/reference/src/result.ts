export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function mapResult<A, B>(
  result: Result<A>,
  mapper: (value: A) => B,
): Result<B> {
  return result.ok
    ? { ok: true, value: mapper(result.value) }
    : { ok: false, error: result.error };
}
