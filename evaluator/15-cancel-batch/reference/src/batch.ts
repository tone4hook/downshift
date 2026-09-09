function abortError(): Error {
  const error = new Error("Batch aborted.");
  error.name = "AbortError";
  return error;
}

export function runBatch<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  signal: AbortSignal,
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    return Promise.reject(new RangeError("Concurrency must be a positive integer."));
  }
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T[]>((resolve, reject) => {
    const results = new Array<T>(tasks.length);
    let next = 0;
    let active = 0;
    let terminal: unknown = null;
    const onAbort = () => {
      if (terminal === null) terminal = abortError();
      pump();
    };
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      if (terminal !== null) reject(terminal);
      else resolve(results);
    };
    const pump = () => {
      if (active === 0 && (terminal !== null || next === tasks.length)) {
        finish();
        return;
      }
      while (terminal === null && active < concurrency && next < tasks.length) {
        const index = next++;
        active++;
        void Promise.resolve()
          .then(() => tasks[index]!())
          .then(
            (value) => { results[index] = value; },
            (error) => { if (terminal === null) terminal = error; },
          )
          .finally(() => {
            active--;
            pump();
          });
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pump();
  });
}
