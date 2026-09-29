// ============================================
// Redis backend-mode truth (DATA_PERSISTENCE_CONFIG_TRUTH-B1).
//
// The API can serve its state either from a real Redis (shared, cross-process)
// or from the in-process MemoryRedis stub. The stub is a legitimate dev/test
// convenience, but in production it would silently make OTP storage, token
// revocation, rate limiting, catalog cache, and EventBus/WebSocket state
// process-local and non-durable.
//
// resolveRedisMode() is the single, pure policy decision. It is deliberately
// free of I/O and env side effects so it can be unit-tested deterministically:
//
//   production + missing/blank/invalid REDIS_URL -> throw (fail closed)
//   production + valid REDIS_URL                 -> REAL
//   test (deterministic)                         -> MEMORY
//   dev/other + missing/blank REDIS_URL          -> MEMORY
//   dev/other + configured REDIS_URL             -> REAL
//
// The error text never includes the raw REDIS_URL, so logs/health can surface
// the failure without leaking credentials.
// ============================================

export type RedisMode = "REAL" | "MEMORY";

export interface RedisModeInput {
  nodeEnv: string | undefined;
  redisUrl: string | undefined;
}

/**
 * Deterministic production configuration error. Thrown when production is
 * asked to select a backend without a usable REDIS_URL so the process fails
 * closed instead of silently downgrading to the in-process memory stub.
 */
export class RedisConfigError extends Error {
  readonly code = "REDIS_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RedisConfigError";
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * A usable Redis URL must parse and use the redis:// or rediss:// scheme.
 * Anything else (http, bare host, malformed) is rejected.
 */
export function isValidRedisUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "redis:" || parsed.protocol === "rediss:";
  } catch {
    return false;
  }
}

export function resolveRedisMode(input: RedisModeInput): RedisMode {
  // Tests must stay deterministic and never require a live Redis.
  if (input.nodeEnv === "test") return "MEMORY";

  if (input.nodeEnv === "production") {
    if (isBlank(input.redisUrl)) {
      throw new RedisConfigError(
        "Refusing to start in production: REDIS_URL is required. Production must " +
          "use a real Redis backend; the in-process memory stub is dev/test-only.",
      );
    }
    if (!isValidRedisUrl(input.redisUrl as string)) {
      throw new RedisConfigError(
        "Refusing to start in production: REDIS_URL is not a valid redis:// or " +
          "rediss:// URL.",
      );
    }
    return "REAL";
  }

  return isBlank(input.redisUrl) ? "MEMORY" : "REAL";
}
