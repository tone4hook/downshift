export interface Config {
  retries: number;
  timeoutMs: number;
  verbose: boolean;
}

export type ConfigEnvironment = Record<string, string | undefined>;

export function resolveConfig(
  defaults: Config,
  file: Partial<Config>,
  env: ConfigEnvironment,
): Config {
  return {
    retries: Number(env.LAB_RETRIES) || file.retries || defaults.retries,
    timeoutMs: Number(env.LAB_TIMEOUT_MS) || file.timeoutMs || defaults.timeoutMs,
    verbose: env.LAB_VERBOSE === "true" || file.verbose || defaults.verbose,
  };
}
