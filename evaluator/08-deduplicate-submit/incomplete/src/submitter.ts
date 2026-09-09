export type Save = (key: string, value: string) => Promise<string>;

export function createSubmitter(save: Save): {
  submit(key: string, value: string): Promise<string>;
} {
  const saved = new Map<string, Promise<string>>();
  return {
    submit(key, value) {
      const existing = saved.get(key);
      if (existing) return existing;
      const request = save(key, value);
      saved.set(key, request);
      return request;
    },
  };
}
