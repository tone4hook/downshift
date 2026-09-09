export interface Config {
  retries: number;
  timeoutMs: number;
  verbose: boolean;
}

export type ConfigEnvironment = Record<string, string | undefined>;

function invalid(): never {
  throw new Error("INVALID_CONFIG");
}

function decimal(value: string, positive: boolean): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (positive ? parsed <= 0 : parsed < 0)) invalid();
  return parsed;
}

export function resolveConfig(
  defaults: Config,
  file: Partial<Config>,
  env: ConfigEnvironment,
): Config {
  const config: Config = { ...defaults, ...file };
  if (env.LAB_RETRIES !== undefined) config.retries = decimal(env.LAB_RETRIES, false);
  if (env.LAB_TIMEOUT_MS !== undefined) config.timeoutMs = decimal(env.LAB_TIMEOUT_MS, true);
  if (env.LAB_VERBOSE !== undefined) {
    if (env.LAB_VERBOSE !== "true" && env.LAB_VERBOSE !== "false") invalid();
    config.verbose = env.LAB_VERBOSE === "true";
  }
  if (
    !Number.isSafeInteger(config.retries) ||
    config.retries < 0 ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs <= 0 ||
    typeof config.verbose !== "boolean"
  ) {
    invalid();
  }
  return config;
}
