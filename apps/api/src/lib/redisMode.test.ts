import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RedisConfigError,
  isValidRedisUrl,
  resolveRedisMode,
} from "./redisMode";
import {
  MemoryRedis,
  assertRedisConfig,
  getRedis,
  getRedisMode,
  resetRedisForTests,
} from "./redis";

// ============================================
// DATA_PERSISTENCE_CONFIG_TRUTH-B1 — CFG1..CFG10.
//
// Verifies the production Redis selection policy is fail-closed and that the
// reported backend mode is truthful. The pure resolver is exercised without
// env side effects; the thin reporting/enforcement wrappers are exercised
// against the global test env (NODE_ENV=test + REDIS_URL from vitest.config).
// ============================================

const VALID_URL = "redis://cache.internal:6379";

describe("resolveRedisMode (Redis backend policy)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRedisForTests();
  });

  // CFG1 — production missing REDIS_URL -> fail closed.
  it("CFG1: production without REDIS_URL fails closed", () => {
    expect(() =>
      resolveRedisMode({ nodeEnv: "production", redisUrl: undefined }),
    ).toThrow(RedisConfigError);
    expect(() =>
      resolveRedisMode({ nodeEnv: "production", redisUrl: undefined }),
    ).toThrow(/REDIS_URL is required/);
    // The enforcement entry point used at startup must also throw.
    expect(() =>
      assertRedisConfig({ nodeEnv: "production", redisUrl: undefined }),
    ).toThrow(RedisConfigError);
  });

  // CFG2 — production blank REDIS_URL -> fail closed.
  it("CFG2: production with a blank REDIS_URL fails closed", () => {
    for (const blank of ["", "   ", "\t", "\n"]) {
      expect(() =>
        resolveRedisMode({ nodeEnv: "production", redisUrl: blank }),
      ).toThrow(RedisConfigError);
    }
  });

  // CFG3 — production valid config -> REAL selected.
  it("CFG3: production with a valid Redis URL selects REAL", () => {
    expect(resolveRedisMode({ nodeEnv: "production", redisUrl: VALID_URL })).toBe("REAL");
    expect(
      resolveRedisMode({ nodeEnv: "production", redisUrl: "rediss://cache.internal:6380" }),
    ).toBe("REAL");
    expect(() =>
      assertRedisConfig({ nodeEnv: "production", redisUrl: VALID_URL }),
    ).not.toThrow();
  });

  it("CFG3b: production with an invalid URL fails closed without echoing the URL", () => {
    for (const bad of ["not-a-url", "http://cache.internal:6379", "localhost:6379"]) {
      let error: unknown;
      try {
        resolveRedisMode({ nodeEnv: "production", redisUrl: bad });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(RedisConfigError);
      // CFG7-adjacent: the message must not leak the (possibly credential-bearing) URL.
      expect((error as Error).message).not.toContain(bad);
    }

    expect(isValidRedisUrl("redis://h:1")).toBe(true);
    expect(isValidRedisUrl("rediss://h:1")).toBe(true);
    expect(isValidRedisUrl("http://h:1")).toBe(false);
    expect(isValidRedisUrl("nope")).toBe(false);
  });

  // CFG4 — test/dev missing Redis -> MEMORY allowed.
  it("CFG4: test/development without Redis URL selects MEMORY", () => {
    expect(resolveRedisMode({ nodeEnv: "test", redisUrl: undefined })).toBe("MEMORY");
    expect(resolveRedisMode({ nodeEnv: "test", redisUrl: "" })).toBe("MEMORY");
    expect(resolveRedisMode({ nodeEnv: "development", redisUrl: undefined })).toBe("MEMORY");
    expect(resolveRedisMode({ nodeEnv: "development", redisUrl: "  " })).toBe("MEMORY");
  });

  it("CFG4b: development with a configured URL selects REAL, never a silent memory downgrade", () => {
    expect(resolveRedisMode({ nodeEnv: "development", redisUrl: VALID_URL })).toBe("REAL");
  });

  // CFG5 — health/config output identifies MEMORY truthfully.
  it("CFG5: test environment reports MEMORY truthfully", () => {
    vi.stubEnv("NODE_ENV", "test");
    resetRedisForTests();
    expect(getRedisMode()).toBe("MEMORY");
    expect(getRedis()).toBeInstanceOf(MemoryRedis);
  });

  // CFG6 — health/config output identifies REAL truthfully.
  it("CFG6: a configured non-test environment reports REAL truthfully", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(getRedisMode()).toBe("REAL");
  });

  // CFG9 — existing Redis consumers still use the selected shared backend.
  it("CFG9: repeated getRedis() resolves to one shared backend instance", () => {
    vi.stubEnv("NODE_ENV", "test");
    resetRedisForTests();
    const first = getRedis();
    const second = getRedis();
    expect(second).toBe(first);
    expect(first).toBeInstanceOf(MemoryRedis);
  });

  // CFG10 — current test environment remains deterministic.
  it("CFG10: test environment stays deterministic (MemoryRedis, no live Redis)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    resetRedisForTests();
    expect(getRedisMode()).toBe("MEMORY");
    const redis = getRedis();
    expect(redis).toBeInstanceOf(MemoryRedis);
    await redis.set("cfg10:key", "value");
    expect(await redis.get("cfg10:key")).toBe("value");
  });
});
