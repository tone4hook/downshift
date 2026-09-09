export async function runBatch<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  signal: AbortSignal,
): Promise<T[]> {
  return Promise.all(tasks.map((task) => task()));
}
