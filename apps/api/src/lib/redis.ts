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
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  connect?(): Promise<void>;
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
let commandFacade: RedisLike | null = null;
let rawIsRealRedis = false;

// Maps a facade back to its underlying raw client so ensureRedisReady() can
// memoize on the raw connection instead of on the facade wrapper.
const facadeToRaw = new WeakMap<RedisLike, RedisLike>();

function getRawCommandClient(): RedisLike {
  if (client) return client;
  if (process.env.NODE_ENV === "test" || !config.redis.url) {
    client = new MemoryRedis();
    rawIsRealRedis = false;
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
  rawIsRealRedis = true;
  return client;
}

// ============================================
// Readiness-gated command facade.
//
// With `lazyConnect` + `enableOfflineQueue: false`, ioredis rejects any command
// issued before the connection is ready. The facade awaits ensureRedisReady()
// on the RAW client before delegating each command, so the first ordinary
// command issued through getRedis() can never race the initial connection.
// Lifecycle/observation members (status/connect/on/off/duplicate/quit) pass
// through ungated to avoid recursive readiness checks and shutdown hangs.
// ============================================
class ReadinessGatedRedis implements RedisLike {
  constructor(private readonly raw: RedisLike) {}

  get status(): string {
    return this.raw.status;
  }

  connect(): Promise<void> {
    return Promise.resolve(this.raw.connect?.());
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    return this.raw.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): unknown {
    return this.raw.off?.(event, listener);
  }

  duplicate(): RedisLike {
    return this.raw.duplicate();
  }

  quit(): Promise<"OK"> {
    return this.raw.quit();
  }

  private ready(): Promise<void> {
    return ensureRedisReady(this.raw);
  }

  async ping(): Promise<string> {
    await this.ready();
    return this.raw.ping();
  }

  async get(key: string): Promise<string | null> {
    await this.ready();
    return this.raw.get(key);
  }

  async set(
    key: string,
    value: string,
    mode?: "PX" | "EX",
    ttl?: number,
  ): Promise<unknown> {
    await this.ready();
    if (mode !== undefined && ttl !== undefined) {
      return this.raw.set(key, value, mode, ttl);
    }
    return this.raw.set(key, value);
  }

  async del(...keys: string[]): Promise<number> {
    await this.ready();
    return this.raw.del(...keys);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    await this.ready();
    return this.raw.zadd(key, score, member);
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    await this.ready();
    return this.raw.zremrangebyscore(key, min, max);
  }

  async zcard(key: string): Promise<number> {
    await this.ready();
    return this.raw.zcard(key);
  }

  async pexpire(key: string, ms: number): Promise<number> {
    await this.ready();
    return this.raw.pexpire(key, ms);
  }

  async publish(channel: string, message: string): Promise<number> {
    await this.ready();
    return this.raw.publish(channel, message);
  }

  async subscribe(
    channel: string,
    onMessage: (channel: string, message: string) => void,
  ): Promise<void> {
    await this.ready();
    return this.raw.subscribe(channel, onMessage);
  }
}

export function getRedis(): RedisLike {
  const raw = getRawCommandClient();
  // Only the real ioredis client is wrapped; the MemoryRedis stub and injected
  // test doubles are returned unchanged so test behavior stays deterministic.
  if (!rawIsRealRedis) return raw;
  if (!commandFacade) {
    commandFacade = new ReadinessGatedRedis(raw);
    facadeToRaw.set(commandFacade, raw);
  }
  return commandFacade;
}

export function resetRedisForTests(): void {
  client = null;
  commandFacade = null;
  rawIsRealRedis = false;
}

export function setRedisForTests(mock: RedisLike): void {
  client = mock;
  commandFacade = null;
  rawIsRealRedis = false;
}

// ============================================
// Readiness gate.
//
// With `lazyConnect: true` + `enableOfflineQueue: false`, ioredis rejects any
// command issued before the connection reports "ready". ensureRedisReady() is
// the single readiness primitive: memoized per client, one in-flight promise
// shared by concurrent callers, and cleared on settle so a failed attempt
// never poisons later attempts. It does not change ioredis retry policy and
// does not swallow ordinary command errors.
// ============================================

const readyPromises = new WeakMap<RedisLike, Promise<void>>();

export function ensureRedisReady(redis: RedisLike = getRedis()): Promise<void> {
  // Normalize a facade to its underlying raw client so memoization and the
  // lifecycle listeners always target the real connection (no recursion).
  const raw = facadeToRaw.get(redis) ?? redis;
  if (raw instanceof MemoryRedis) return Promise.resolve();
  if (raw.status === "ready") return Promise.resolve();

  const inFlight = readyPromises.get(raw);
  if (inFlight) return inFlight;

  const promise = attemptRedisReady(raw).finally(() => {
    readyPromises.delete(raw);
  });
  readyPromises.set(raw, promise);
  return promise;
}

async function attemptRedisReady(redis: RedisLike): Promise<void> {
  const status = redis.status;
  if (
    status === "connecting" ||
    status === "connect" ||
    status === "reconnecting"
  ) {
    return waitForRedisReady(redis);
  }
  if (typeof redis.connect === "function") {
    await redis.connect();
    return;
  }
  return waitForRedisReady(redis);
}

function waitForRedisReady(redis: RedisLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (redis.status === "ready") {
      resolve();
      return;
    }
    const cleanup = (): void => {
      redis.off?.("ready", onReady);
      redis.off?.("error", onError);
      redis.off?.("end", onEnd);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("redis_ended_before_ready"));
    };
    redis.on("ready", onReady);
    redis.on("error", onError);
    redis.on("end", onEnd);
    if (redis.status === "ready") {
      cleanup();
      resolve();
    }
  });
}

// ============================================
// Dedicated EventBus subscriber.
//
// The command client (getRedis) must NEVER enter subscriber mode: doing so
// breaks every non-subscriber command on that connection (OTP, JWT, rate
// limit, cache, publish). EventBus subscribes on one dedicated duplicate
// connection instead. In memory mode the stub's subscribe() is a no-op, so
// reusing the command instance cannot poison anything.
// ============================================

let subscriber: RedisLike | null = null;

export function getRedisSubscriber(): RedisLike {
  // Always duplicate the RAW command client, never the gated facade, so the
  // subscriber owns a physically distinct connection.
  const command = getRawCommandClient();
  if (command instanceof MemoryRedis) return command;
  if (!subscriber) {
    subscriber = command.duplicate();
  }
  return subscriber;
}

export async function closeRedisSubscriber(): Promise<void> {
  const sub = subscriber;
  subscriber = null;
  if (!sub || sub instanceof MemoryRedis) return;
  try {
    await sub.quit();
  } catch (err) {
    logger.warn({
      message: "redis_subscriber_close_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function resetRedisSubscriberForTests(): void {
  subscriber = null;
}
