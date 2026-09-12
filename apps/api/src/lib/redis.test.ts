import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real branch of getRedis() constructs `new Redis(url, opts)`. To exercise
// the readiness-gated facade without a live server we replace the ioredis
// default export with a controllable in-memory double.
const h = vi.hoisted(() => {
  const instances: FakeIoredis[] = [];

  class FakeIoredis {
    status = "wait";
    connectCalls = 0;
    quitCalls = 0;
    duplicateCalls = 0;
    setArgs: unknown[][] = [];
    connectMode: "auto" | "manual" | "reject-once" = "auto";

    private rejectedOnce = false;
    private pendingConnects: Array<{ resolve: () => void }> = [];
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor(_url?: string, _opts?: unknown) {
      instances.push(this);
    }

    connect(): Promise<void> {
      this.connectCalls++;
      if (this.connectMode === "reject-once" && !this.rejectedOnce) {
        this.rejectedOnce = true;
        return Promise.reject(new Error("connect refused"));
      }
      if (this.connectMode === "manual") {
        return new Promise<void>((resolve) => {
          this.pendingConnects.push({ resolve });
        });
      }
      this.status = "ready";
      this.emit("ready");
      return Promise.resolve();
    }

    fulfillConnect(): void {
      this.status = "ready";
      this.emit("ready");
      for (const pending of this.pendingConnects.splice(0)) pending.resolve();
    }

    on(event: string, listener: (...args: unknown[]) => void): unknown {
      let set = this.listeners.get(event);
      if (!set) {
        set = new Set();
        this.listeners.set(event, set);
      }
      set.add(listener);
      return this;
    }

    off(event: string, listener: (...args: unknown[]) => void): unknown {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }

    duplicate(): FakeIoredis {
      this.duplicateCalls++;
      return this;
    }

    async ping(): Promise<string> {
      return "PONG";
    }

    async get(_key: string): Promise<string | null> {
      return null;
    }

    async set(...args: unknown[]): Promise<unknown> {
      this.setArgs.push(args);
      return "OK";
    }

    async del(..._keys: string[]): Promise<number> {
      return 0;
    }

    async zadd(_key: string, _score: number, _member: string): Promise<number> {
      return 0;
    }

    async zremrangebyscore(_key: string, _min: number, _max: number): Promise<number> {
      return 0;
    }

    async zcard(_key: string): Promise<number> {
      return 0;
    }

    async pexpire(_key: string, _ms: number): Promise<number> {
      return 0;
    }

    async quit(): Promise<"OK"> {
      this.quitCalls++;
      return "OK";
    }

    async publish(_channel: string, _message: string): Promise<number> {
      return 1;
    }

    async subscribe(
      _channel: string,
      _onMessage: (channel: string, message: string) => void,
    ): Promise<void> {
      // no-op
    }
  }

  return { FakeIoredis, instances };
});

vi.mock("ioredis", () => ({ default: h.FakeIoredis }));

import {
  MemoryRedis,
  ensureRedisReady,
  getRedis,
  resetRedisForTests,
  setRedisForTests,
} from "./redis";
import type { RedisLike } from "./redis";

function latestFake(): InstanceType<typeof h.FakeIoredis> {
  const instance = h.instances.at(-1);
  if (!instance) throw new Error("no FakeIoredis constructed");
  return instance;
}

describe("redis readiness + facade (EVENTBUS-REDIS-ISOLATION)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    resetRedisForTests();
    h.instances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("RUT1: test env keeps MemoryRedis immediate/deterministic (no facade)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    resetRedisForTests();

    const redis = getRedis();
    expect(redis).toBeInstanceOf(MemoryRedis);
    expect(redis.status).toBe("ready");

    await redis.set("k", "v");
    expect(await redis.get("k")).toBe("v");
    expect(h.instances.length).toBe(0);
  });

  it("RUT2: concurrent first commands share a single readiness attempt", async () => {
    const redis = getRedis();
    const raw = latestFake();
    raw.connectMode = "manual";

    const a = redis.set("k", "v");
    const b = redis.get("k");
    const c = ensureRedisReady(redis);
    expect(raw.connectCalls).toBe(1);

    raw.fulfillConnect();
    await Promise.all([a, b, c]);

    expect(raw.connectCalls).toBe(1);
    expect(raw.setArgs[0]).toEqual(["k", "v"]);
  });

  it("RUT3: a failed readiness attempt does not poison later attempts", async () => {
    const redis = getRedis();
    const raw = latestFake();
    raw.connectMode = "reject-once";

    await expect(redis.get("k")).rejects.toThrow("connect refused");
    expect(raw.connectCalls).toBe(1);

    raw.connectMode = "auto";
    await expect(redis.set("k", "v")).resolves.toBe("OK");
    expect(raw.connectCalls).toBe(2);
    expect(raw.setArgs[0]).toEqual(["k", "v"]);
  });

  it("RUT4: ordinary command errors propagate to the caller", async () => {
    const redis = getRedis();
    const raw = latestFake();
    raw.status = "ready";
    raw.ping = async () => {
      throw new Error("boom");
    };

    await expect(redis.ping()).rejects.toThrow("boom");
    expect(raw.connectCalls).toBe(0);
  });

  it("RUT5: lifecycle members are not readiness-gated", async () => {
    const redis = getRedis();
    const raw = latestFake();

    expect(redis.status).toBe(raw.status);

    const seen: number[] = [];
    const listener = (...args: unknown[]): void => {
      seen.push(args[0] as number);
    };
    redis.on("custom", listener);
    raw.emit("custom", 1);
    redis.off?.("custom", listener);
    raw.emit("custom", 2);
    expect(seen).toEqual([1]);

    const before = raw.connectCalls;
    await redis.connect?.();
    expect(raw.connectCalls).toBe(before + 1);

    expect(redis.duplicate()).toBe(raw);
    expect(raw.duplicateCalls).toBe(1);

    await redis.quit();
    expect(raw.quitCalls).toBe(1);
    expect(raw.connectCalls).toBe(before + 1);
  });

  it("RUT6: set() never forwards undefined mode/ttl to ioredis", async () => {
    const redis = getRedis();
    const raw = latestFake();
    raw.status = "ready";

    await redis.set("k", "v");
    expect(raw.setArgs[0]).toEqual(["k", "v"]);

    await redis.set("k", "v", "PX", 1000);
    expect(raw.setArgs[1]).toEqual(["k", "v", "PX", 1000]);
  });

  it("RUT7: reset/injection do not retain stale facade or raw references", () => {
    const first = getRedis();
    const firstRaw = latestFake();

    const injected = new h.FakeIoredis();
    setRedisForTests(injected as unknown as RedisLike);
    expect(getRedis()).toBe(injected);

    resetRedisForTests();
    const second = getRedis();
    const secondRaw = latestFake();

    expect(second).not.toBe(first);
    expect(secondRaw).not.toBe(firstRaw);
    expect(second).not.toBe(injected);
  });
});
