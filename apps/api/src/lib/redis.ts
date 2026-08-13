import Redis from "ioredis";
import { config } from "../config";
import { logger } from "./logger";

// ============================================
// Redis client factory. In test env returns a stub
// (rate limiter / OTP storage) via a memory Map so
// tests run without a live Redis.
// ============================================

export interface RedisLike {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode?: "PX" | "EX",
    ttl?: number,
  ): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  quit(): Promise<"OK">;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  duplicate(): RedisLike;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, onMessage: (channel: string, message: string) => void): Promise<void>;
  status: string;
}

export class MemoryRedis implements RedisLike {
  private store = new Map<string, string>();
  private zsets = new Map<string, Map<string, number>>();

  status = "ready";

  async ping(): Promise<string> {
    return "PONG";
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    mode?: "PX" | "EX",
    ttl?: number,
  ): Promise<"OK"> {
    this.store.set(key, value);
    if (mode && ttl && ttl > 0) {
      const ms = mode === "PX" ? ttl : ttl * 1000;
      setTimeout(() => {
        if (this.store.get(key) === value) this.store.delete(key);
      }, ms);
    }
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.store.delete(k)) n++;
      if (this.zsets.delete(k)) n++;
    }
    return n;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }
    const existed = set.has(member);
    set.set(member, score);
    return existed ? 0 : 1;
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    const set = this.zsets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const [member, score] of set) {
      if (score >= min && score <= max) {
        set.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    if (!this.store.has(key) && !this.zsets.has(key)) return 0;
    setTimeout(() => {
      this.store.delete(key);
      this.zsets.delete(key);
    }, ms);
    return 1;
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }

  on(): unknown {
    return this;
  }

  duplicate(): RedisLike {
    return this;
  }

  async publish(): Promise<number> {
    return 0;
  }

  async subscribe(_channel: string, _onMessage: (channel: string, message: string) => void): Promise<void> {
    // no-op in memory mode
  }
}

let client: RedisLike | null = null;

export function getRedis(): RedisLike {
  if (client) return client;
  if (process.env.NODE_ENV === "test" || !config.redis.url) {
    client = new MemoryRedis();
    return client;
  }
  const redis = new Redis(config.redis.url, {
    // Fail fast instead of queueing + throwing MaxRetriesPerRequestError,
    // enabling graceful degradation (EOS resilience) when Redis is down.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on("error", (err) => {
    // Resilience: log and continue; rate limiting degrades to allow.
    logger.warn({ message: "redis_error", error: err.message });
  });
  // Guard against unhandled rejections from commands issued while down.
  redis.on("end", () => {
    logger.warn({ message: "redis_disconnected" });
  });
  // ioredis exposes a heavily overloaded `set`; the structural surface we use
  // (set/get/del/zadd/zremrangebyscore/zcard/pexpire) is guaranteed by ioredis.
  client = redis as unknown as RedisLike;
  return client as RedisLike;
}
export function resetRedisForTests(): void {
  client = null;
}

export function setRedisForTests(mock: RedisLike): void {
  client = mock;
}
