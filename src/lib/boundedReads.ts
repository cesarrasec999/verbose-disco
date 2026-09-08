export async function mapBounded<T, R>(values: readonly T[], load: (value: T) => Promise<R>, concurrency = 3): Promise<R[]> {
  const result: R[] = new Array(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) { const current = index++; result[current] = await load(values[current]); }
  }));
  return result;
}

const reads = new Map<string, { expires: number; value: Promise<unknown> }>();
/** Session-scoped keys; failed reads are never cached as empty success. */
export function cachedRead<T>(key: string, load: () => Promise<T>, ttlMs = 60000, force = false): Promise<T> {
  const old = reads.get(key);
  if (!force && old && old.expires > Date.now()) return old.value as Promise<T>;
  const value = load();
  reads.set(key, { expires: Date.now() + ttlMs, value });
  void value.catch(() => { if (reads.get(key)?.value === value) reads.delete(key); });
  if (reads.size > 100) for (const [key, entry] of reads) if (entry.expires <= Date.now()) reads.delete(key);
  return value;
}
