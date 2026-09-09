# Configuration precedence

Implement `resolveConfig(defaults, file, env)` in `src/config.ts`.

- Precedence is defaults, then file, then defined environment values.
- Preserve explicit `false` and `0`; ignore missing environment keys.
- `LAB_RETRIES` is a decimal nonnegative integer, `LAB_TIMEOUT_MS` a decimal
  positive integer, and `LAB_VERBOSE` exactly `"true"` or `"false"`.
- Empty or otherwise invalid environment values are errors.
- Validate the final typed values, throw one `INVALID_CONFIG` error for invalid
  configuration, ignore unrelated environment keys, and do not mutate inputs.
