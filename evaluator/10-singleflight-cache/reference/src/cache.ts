export function createCache(
  load: (key: string) => Promise<string>,
  now: () => number,
  ttlMs: number,
): { get(key: string): Promise<string> } {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("TTL must be positive and finite.");
  }
  const values = new Map<string, { value: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();
  return {
    get(key) {
      const cached = values.get(key);
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
      values.delete(key);
      const existing = pending.get(key);
      if (existing) return existing;
      const request = load(key).then((value) => {
        values.set(key, { value, expiresAt: now() + ttlMs });
        pending.delete(key);
        return value;
      }, (error) => {
        pending.delete(key);
        throw error;
      });
      pending.set(key, request);
      return request;
    },
  };
}
