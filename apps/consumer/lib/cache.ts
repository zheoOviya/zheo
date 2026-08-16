// Client-side in-memory cache for frequently-read loyalty endpoints.
// Keys are `resource:token[:param]`. Entries expire after a short TTL
// and are eagerly invalidated after mutations (order placed, referral
// applied) so users never see stale balances.

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export function getCached<T>(key: string, now: number = Date.now()): T | null {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (now >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function setCached<T>(
  key: string,
  value: T,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now(),
): void {
  store.set(key, { value, expiresAt: now + ttlMs });
}

export function invalidateByPrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function clearCache(): void {
  store.clear();
}

export async function cached<T>(
  key: string,
  load: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const hit = getCached<T>(key);
  if (hit !== null) return hit;
  const data = await load();
  setCached(key, data, ttlMs);
  return data;
}
