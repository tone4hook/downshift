function abortError(): Error {
  const error = new Error("Batch aborted.");
  error.name = "AbortError";
  return error;
}

export async function runBatch<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  signal: AbortSignal,
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new RangeError("Invalid concurrency.");
  const results: T[] = [];
  for (let index = 0; index < tasks.length; index += concurrency) {
    if (signal.aborted) throw abortError();
    results.push(...await Promise.all(tasks.slice(index, index + concurrency).map((task) => task())));
  }
  return results;
}
