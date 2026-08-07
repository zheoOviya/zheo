import { getRedis } from "../lib/redis";
import { logger } from "../lib/logger";

// ============================================
// Redis Cache-Aside (EOS 1.1 / PRD caching mandate)
// getOrSet: read-through cache with TTL.
// Never caches DB objects - always serialized payloads.
// ============================================

export async function getOrSet<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const redis = getRedis();

  let cached: string | null = null;
  try {
    cached = await redis.get(key);
  } catch (err) {
    logger.warn({
      message: "cache_read_failure",
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (cached !== null) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // corrupted entry - treat as miss
    }
  }

  const fresh = await loader();
  const serialized = JSON.stringify(fresh);
  if (fresh !== null && fresh !== undefined) {
    try {
      await redis.set(key, serialized, "EX", ttlSeconds);
    } catch (err) {
      logger.warn({
        message: "cache_write_failure",
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return fresh;
}

export function cacheKey(...parts: string[]): string {
  return `cache:${parts.join(":")}`;
}

export async function invalidateCache(...keys: string[]): Promise<void> {
  const redis = getRedis();
  if (keys.length > 0) {
    await redis.del(...keys).catch(() => undefined);
  }
  logger.info({ message: "cache_invalidated", keys });
}
