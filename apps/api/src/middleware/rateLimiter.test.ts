import { beforeEach, describe, expect, it } from "vitest";
import { resetRedisForTests, getRedis, setRedisForTests } from "../lib/redis";
import { checkRateLimit } from "./rateLimiter";
import type { RedisLike } from "../lib/redis";

describe("Redis sliding-window rate limiter", () => {
  beforeEach(() => {
    resetRedisForTests();
  });

  it("allows requests up to the max within a window", async () => {
    const key = "rl:test:phone1";
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await checkRateLimit(key, 3, 60_000));
    }
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(results.at(-1)?.current).toBe(3);
  });

  it("rejects requests beyond the max", async () => {
    const key = "rl:test:phone2";
    for (let i = 0; i < 3; i++) {
      await checkRateLimit(key, 3, 60_000);
    }
    const over = await checkRateLimit(key, 3, 60_000);
    expect(over.allowed).toBe(false);
    expect(over.current).toBe(4);
  });

  it("treats identifiers as separate windows", async () => {
    await checkRateLimit("rl:test:a", 3, 60_000);
    await checkRateLimit("rl:test:a", 3, 60_000);
    await checkRateLimit("rl:test:a", 3, 60_000);
    const other = await checkRateLimit("rl:test:b", 3, 60_000);
    expect(other.allowed).toBe(true);
    expect(other.current).toBe(1);
  });

  it("expires entries older than the window (sliding)", async () => {
    const key = "rl:test:window";
    await checkRateLimit(key, 1, 1);
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await checkRateLimit(key, 1, 1);
    expect(fresh.allowed).toBe(true);
    expect(fresh.current).toBe(1);
  });

  describe("fail-closed behaviour (Sprint 6)", () => {
    it("returns allowed: false and current: -1 when failClosed and Redis fails", async () => {
      const broken: RedisLike = {
        ...getRedis(),
        zremrangebyscore: () => { throw new Error("Redis connection refused"); },
        zadd: async () => 0,
        zcard: async () => 0,
        pexpire: async () => 0,
      };
      setRedisForTests(broken);

      const result = await checkRateLimit("rl:fc:test", 3, 60_000, true);
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(-1);
    });

    it("returns allowed: true when failClosed is false and Redis fails", async () => {
      const result = await checkRateLimit("rl:fo:test", 3, 60_000, false);
      expect(result.allowed).toBe(true);
    });
  });
});
