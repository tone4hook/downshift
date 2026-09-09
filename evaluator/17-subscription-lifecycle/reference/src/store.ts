export interface Store<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  let nextId = 0;
  let dispatching = false;
  const listeners = new Map<number, (value: T) => void>();
  const queue: T[] = [];
  return {
    get: () => value,
    set(next) {
      queue.push(next);
      if (dispatching) return;
      dispatching = true;
      let firstError: unknown = null;
      try {
        while (queue.length > 0) {
          value = queue.shift()!;
          for (const listener of [...listeners.values()]) {
            try {
              listener(value);
            } catch (error) {
              if (firstError === null) firstError = error;
            }
          }
        }
      } finally {
        dispatching = false;
      }
      if (firstError !== null) throw firstError;
    },
    subscribe(listener) {
      const id = nextId++;
      listeners.set(id, listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(id);
      };
    },
  };
}
