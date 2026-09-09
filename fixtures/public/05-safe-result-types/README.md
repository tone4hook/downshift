# Safe result mapping

Repair the generic result mapping in `src/result.ts`.

- Export `Result<T> = { ok: true; value: T } | { ok: false; error: string }`.
- Export `mapResult<A, B>(result: Result<A>, mapper: (value: A) => B): Result<B>`.
- Call the mapper only for a successful result and infer its output type as `B`.
- Preserve the error string for an error result.
- Do not mutate the input. Let mapper exceptions propagate.
- Keep invalid mapper argument types rejected by strict TypeScript checking; do not repair the API with `any` or unchecked casts.
