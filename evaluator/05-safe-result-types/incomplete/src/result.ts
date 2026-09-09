export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function mapResult<A>(
  result: Result<A>,
  mapper: (value: A) => A,
): Result<A> {
  return result.ok
    ? { ok: true, value: mapper(result.value) }
    : { ok: false, error: result.error };
}
