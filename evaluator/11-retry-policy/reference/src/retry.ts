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
    throw new RangeError("maxAttempts must be a positive integer.");
  }
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === options.maxAttempts || !options.shouldRetry(error)) throw error;
      await options.delay(attempt);
    }
  }
  throw new Error("Unreachable retry state.");
}
