export function createCache(
  load: (key: string) => Promise<string>,
  now: () => number,
  ttlMs: number,
): { get(key: string): Promise<string> } {
  const values = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const cached = values.get(key);
      if (cached && now() < cached.expiresAt) return cached.value;
      const expiresAt = now() + ttlMs;
      const value = await load(key);
      values.set(key, { value, expiresAt });
      return value;
    },
  };
}
