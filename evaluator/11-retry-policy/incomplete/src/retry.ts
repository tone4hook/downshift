export interface RetryOptions {
  maxAttempts: number;
  delay(attempt: number): Promise<void>;
  shouldRetry(error: unknown): boolean;
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0) {
    throw new RangeError("Invalid attempt limit.");
  }
  for (let attempt = 1; attempt <= options.maxAttempts + 1; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!options.shouldRetry(error)) throw error;
      await options.delay(attempt);
    }
  }
  throw new Error("Retry exhausted.");
}
