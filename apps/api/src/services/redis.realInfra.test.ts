import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

// ============================================
// Real-Redis integration proof (Task 6C.1).
//
// Opt-in only: the suite is inert unless TEST_REAL_INFRA=true (the real-infra
// switch implemented in 6B). When opted in it is NEVER skipped silently: every
// test talks to a live Redis and any outage surfaces as a failing test.
//
// REDIS_URL is stubbed before the modules are (re-)imported so the config
// snapshot picks up the real instance (the root vitest config forces a dead
// default URL; the live instance runs on another port).
// ============================================

const realInfra = process.env.TEST_REAL_INFRA === "true";
const realRedisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6389";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type RedisLike = import("../lib/redis").RedisLike;

describe.skipIf(!realInfra)("real Redis integration (TEST_REAL_INFRA=true)", () => {
  let redis: typeof import("../lib/redis");
  let eventBus: typeof import("../lib/eventBus");
  let jwt: typeof import("./jwt");

  let commandClient: RedisLike;
  let subscriberConn: RedisLike | null = null;
  let monitor: Redis | null = null;
  let foreign: Redis | null = null;
  const wireMessages: string[] = [];

  beforeAll(async () => {
    // Real infra + a live REDIS_URL must be visible to the modules BEFORE
    // they are (re-)imported, otherwise the config snapshot keeps the dead
    // default URL from the root vitest config.
    vi.stubEnv("TEST_REAL_INFRA", "true");
    vi.stubEnv("REDIS_URL", realRedisUrl);
    vi.resetModules();
    redis = await import("../lib/redis");
    eventBus = await import("../lib/eventBus");
    jwt = await import("./jwt");

    commandClient = redis.getRedis();
    // lazyConnect: bring the shared command client up like the app's own
    // subscriber path does (eventBus calls sub.connect() before subscribe).
    await commandClient.connect();

    // Capture the subscriber's duplicate connection so the suite can prove it
    // is a distinct connection and tear it down afterwards.
    const originalDuplicate = commandClient.duplicate.bind(commandClient);
    vi.spyOn(commandClient, "duplicate").mockImplementation(() => {
      const dup = originalDuplicate();
      subscriberConn = dup;
      return dup;
    });

    await eventBus.initEventSubscriber();

    // Raw helper connections that do not depend on the module singleton.
    monitor = new Redis(realRedisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    await monitor.connect();
    await monitor.subscribe("snakzap:events");
    monitor.on("message", (channel: string, message: string) => {
      if (channel === "snakzap:events") wireMessages.push(message);
    });

    foreign = new Redis(realRedisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    await foreign.connect();
  });

  afterAll(async () => {
    if (subscriberConn) {
      try {
        await subscriberConn.quit();
      } catch {
        // already closed
      }
    }
    if (monitor) {
      try {
        await monitor.quit();
      } catch {
        // already closed
      }
    }
    if (foreign) {
      try {
        await foreign.quit();
      } catch {
        // already closed
      }
    }
    if (commandClient) {
      try {
        await commandClient.quit();
      } catch {
        // already closed
      }
    }
    vi.unstubAllEnvs();
  });

  it("connects to the real Redis instance (PING -> PONG)", async () => {
    expect(await commandClient.ping()).toBe("PONG");
  });

  it("uses a real ioredis client, not MemoryRedis", async () => {
    expect(commandClient).not.toBeInstanceOf(redis.MemoryRedis);
    expect(commandClient.status).toBe("ready");
  });

  it("keeps the shared command client usable while the subscriber is active", async () => {
    const key = `realredis:cmd:${randomUUID()}`;
    await commandClient.set(key, "hello", "EX", 60);
    expect(await commandClient.get(key)).toBe("hello");
    await commandClient.del(key);
    expect(await commandClient.get(key)).toBeNull();
  });

  it("runs the event subscriber on a duplicated connection, distinct from the command client", async () => {
    expect(subscriberConn).not.toBeNull();
    expect(subscriberConn).not.toBe(commandClient);
    const numsub = (await foreign!.call("PUBSUB", "NUMSUB", "snakzap:events")) as [
      string,
      number,
    ];
    expect(numsub[0]).toBe("snakzap:events");
    // the eventBus subscriber connection + this suite's monitor
    expect(numsub[1]).toBeGreaterThanOrEqual(2);
  });

  it("dispatch via emit happens exactly once: the self-origin Redis loop-back is suppressed", async () => {
    const handler = vi.fn();
    eventBus.onEvent("OrderCreated", handler);
    const before = wireMessages.length;
    const envelope = eventBus.createEventEnvelope(
      "OrderCreated",
      `self-${randomUUID()}`,
      {},
    );

    await eventBus.emit(envelope);
    await sleep(300);

    // The publish genuinely reached Redis: the monitor received exactly one
    // copy on the channel.
    expect(wireMessages.length).toBe(before + 1);
    const parsed = JSON.parse(wireMessages[before]!) as {
      origin_instance_id: string;
    };
    expect(typeof parsed.origin_instance_id).toBe("string");
    // Local dispatch fired once; the loop-back that returned via the real
    // subscriber connection was filtered by origin.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("dispatches a foreign-origin Redis broadcast exactly once", async () => {
    const handler = vi.fn();
    eventBus.onEvent("OrderCreated", handler);
    const remote = eventBus.createEventEnvelope(
      "OrderCreated",
      `foreign-${randomUUID()}`,
      {},
    );
    const wire = JSON.stringify({
      origin_instance_id: "instance-foreign",
      event: remote,
    });

    await foreign!.publish("snakzap:events", wire);
    await sleep(300);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].aggregate_id).toBe(remote.aggregate_id);
  });

  it("writes a JWT blacklist entry through real Redis and reads it back", async () => {
    const service = new jwt.JwtService();
    const jti = randomUUID();

    await service.blacklistRefreshToken(jti);

    expect(await service.isRefreshTokenBlacklisted(jti)).toBe(true);
    // Cross-check on a raw connection: the entry physically lives in Redis.
    expect(await foreign!.get(`jwt:blacklist:${jti}`)).toBe("1");
  });

  it("rotateRefreshToken rejects a blacklisted refresh token (reuse detection)", async () => {
    const service = new jwt.JwtService();
    const claims = {
      sub: "u-reuse",
      phone: "9999999999",
      role: "customer",
      device_fingerprint: "dev-fp",
    };
    const { refreshToken, refreshJti } = service.issuePair(claims);

    await service.blacklistRefreshToken(refreshJti);

    await expect(
      service.rotateRefreshToken(refreshToken, "dev-fp", async () => ({
        phone: "9999999999",
        role: "customer",
        is_suspended: false,
      })),
    ).rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSED" });
  });
});
