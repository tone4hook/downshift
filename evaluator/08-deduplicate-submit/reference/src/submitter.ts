export type Save = (key: string, value: string) => Promise<string>;

export function createSubmitter(save: Save): {
  submit(key: string, value: string): Promise<string>;
} {
  const pending = new Map<string, Promise<string>>();
  return {
    submit(key, value) {
      const existing = pending.get(key);
      if (existing) return existing;
      const request = save(key, value);
      pending.set(key, request);
      void request.then(
        () => {
          if (pending.get(key) === request) pending.delete(key);
        },
        () => {
          if (pending.get(key) === request) pending.delete(key);
        },
      );
      return request;
    },
  };
}
