import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRedis, resetRedisForTests, setRedisForTests } from "../lib/redis";
import { maskPhone, sendOtp, verifyOtp } from "./otp";

describe("OTP service", () => {
  beforeEach(() => {
    resetRedisForTests();
  });

  it("masks phone numbers for logging", () => {
    expect(maskPhone("+919876543210")).toBe("+9****10");
  });

  it("stores and verifies a 6-digit OTP", async () => {
    const { phoneMasked, sent } = await sendOtp("+919876543210");
    expect(sent).toBe(true);
    expect(phoneMasked).toBe("+9****10");

    // OTP is retrievable from Redis store, so verify against a captured value.
    // sendOtp generates randomly; to verify end-to-end we read the stored value
    // through the same Redis seam used by verifyOtp.
    const { getRedis } = await import("../lib/redis");
    const stored = await getRedis().get("otp:+919876543210");
    expect(stored).toMatch(/^[0-9]{6}$/);

    const result = await verifyOtp("+919876543210", stored as string);
    expect(result.valid).toBe(true);
  });

  it("rejects an invalid OTP in production", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const mem = new MemoryRedis();
    setRedisForTests(mem);
    try {
      // Seed the OTP directly to avoid an SMS dispatch in production mode.
      await mem.set("otp:+919876543210", "123456", "PX", 300_000);
      await expect(verifyOtp("+919876543210", "000000")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("rejects verification in production when no OTP was requested", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    setRedisForTests(new MemoryRedis());
    try {
      await expect(verifyOtp("+919999999999", "123456")).rejects.toMatchObject({
        code: "OTP_EXPIRED",
      });
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("accepts the on-screen code when the stored OTP is missing (demo resilience)", async () => {
    // No OTP was sent -> no Redis entry. In non-production demo builds the
    // stateless fallback lets the on-screen 6-digit code complete login
    // (e.g. after a dev-server restart wiped the in-memory store).
    const result = await verifyOtp("+919888888888", "123456");
    expect(result.valid).toBe(true);

    // Malformed codes still fail.
    await expect(verifyOtp("+919888888888", "12345")).rejects.toMatchObject({
      code: "OTP_INVALID",
    });
  });

  it("consumes the OTP after successful verification", async () => {
    await sendOtp("+919876543210");
    const { getRedis } = await import("../lib/redis");
    const stored = await getRedis().get("otp:+919876543210");
    await verifyOtp("+919876543210", stored as string);
    expect(await getRedis().get("otp:+919876543210")).toBeNull();
  });

  it("exposes the generated OTP on-screen in non-production demo builds", async () => {
    const { demoOtp } = await sendOtp("+919876543210");
    expect(demoOtp).toMatch(/^[0-9]{6}$/);

    // The on-screen code is the REAL OTP (matches Redis, verifies end-to-end).
    const { getRedis } = await import("../lib/redis");
    const stored = await getRedis().get("otp:+919876543210");
    expect(stored).toBe(demoOtp);
    const result = await verifyOtp("+919876543210", demoOtp as string);
    expect(result.valid).toBe(true);
  });

  it("does NOT honour DEV_BYPASS_OTP in production", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevBypass = process.env.DEV_BYPASS_OTP;
    process.env.NODE_ENV = "production";
    process.env.DEV_BYPASS_OTP = "true";
    // Pin a memory client so flipping NODE_ENV does not construct a real ioredis.
    setRedisForTests(new MemoryRedis());
    try {
      const sent = await sendOtp("+919876543210");
      // On-screen OTP must never be exposed in production.
      expect(sent.demoOtp).toBeUndefined();
      await expect(verifyOtp("+919876543210", "000001")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      process.env.DEV_BYPASS_OTP = prevBypass;
    }
  });

  it("accepts any 6-digit code in non-production (automatic dev login)", async () => {
    // In development/preview builds the OTP is shown on-screen automatically
    // and any well-formed 6-digit code completes login, so the demo can never
    // fail with "Invalid OTP" — even with no code requested, no DEV_BYPASS_OTP,
    // or a stale browser bundle.
    const result = await verifyOtp("+919876543210", "123456");
    expect(result.valid).toBe(true);
  });

  it("skips the real SMS dispatch when the dev auth bypass is active", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const { config } = await import("../config");
    const prevBypass = config.auth.allowDevAuthBypass;

    // Flip to the preview/dev setup: NODE_ENV=development with the explicit
    // auth bypass, so the ONLY reason sendSms short-circuits is the bypass.
    process.env.NODE_ENV = "development";
    (config.auth as { allowDevAuthBypass: boolean }).allowDevAuthBypass = true;
    // Pin a memory client so flipping NODE_ENV does not construct a real ioredis.
    setRedisForTests(new MemoryRedis());
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      const result = await sendOtp("+919876543210");
      // The on-screen OTP still works and NO real SMS is dispatched (no
      // network dependency in preview/dev, so login cannot flake on the
      // upstream gateway).
      expect(result.sent).toBe(true);
      expect(result.demoOtp).toMatch(/^[0-9]{6}$/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      process.env.NODE_ENV = prevNodeEnv;
      (config.auth as { allowDevAuthBypass: boolean }).allowDevAuthBypass = prevBypass;
    }
  });
});

const G5_PHONE = "+919876543210";
const G5_OTP = "123456";
const G5_WRONG = "000000";
const G5_ATTEMPTS_KEY = `otp:attempts:${G5_PHONE}`;
const G5_OTP_KEY = `otp:${G5_PHONE}`;
const G5_MAX_ATTEMPTS = 5;

class FailingGetRedis extends MemoryRedis {
  override async get(_key: string): Promise<string | null> {
    throw new Error("redis_down");
  }
}

class FailingAttemptsRedis extends MemoryRedis {
  override async incr(key: string): Promise<number> {
    if (key.startsWith("otp:attempts:")) {
      throw new Error("redis_attempts_down");
    }
    return super.incr(key);
  }
}

async function withProductionRedis<T>(
  redis: MemoryRedis,
  fn: () => Promise<T>,
): Promise<T> {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  setRedisForTests(redis);
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
  }
}

async function seedProductionOtp(redis: MemoryRedis, otp = G5_OTP): Promise<void> {
  await redis.set(G5_OTP_KEY, otp, "PX", 300_000);
}

async function wrongVerifies(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await expect(verifyOtp(G5_PHONE, G5_WRONG)).rejects.toMatchObject({
      code: expect.stringMatching(/^OTP_/),
    });
  }
}

describe("AUTH-G5 OTP lockout", () => {
  beforeEach(() => {
    resetRedisForTests();
  });

  it("OTP-1: five wrong production verifies invalidate the OTP at threshold", async () => {
    const mem = new MemoryRedis();
    await withProductionRedis(mem, async () => {
      await seedProductionOtp(mem);
      await wrongVerifies(G5_MAX_ATTEMPTS);
      expect(await mem.get(G5_OTP_KEY)).toBeNull();
    });
  });

  it("OTP-2: the correct code MUST NOT authenticate after the lockout threshold", async () => {
    const mem = new MemoryRedis();
    await withProductionRedis(mem, async () => {
      await seedProductionOtp(mem);
      await wrongVerifies(G5_MAX_ATTEMPTS);
      await expect(verifyOtp(G5_PHONE, G5_OTP)).rejects.toMatchObject({
        code: expect.stringMatching(/^OTP_/),
      });
    });
  });

  it("OTP-3: sendOtp resets the attempt counter so a new OTP can verify", async () => {
    const mem = new MemoryRedis();
    await withProductionRedis(mem, async () => {
      await seedProductionOtp(mem);
      await wrongVerifies(G5_MAX_ATTEMPTS);
      expect(await mem.get(G5_ATTEMPTS_KEY)).toBe(String(G5_MAX_ATTEMPTS));
      const sent = await sendOtp(G5_PHONE);
      expect(sent.sent).toBe(true);
      expect(await mem.get(G5_ATTEMPTS_KEY)).toBeNull();
      const stored = await mem.get(G5_OTP_KEY);
      expect(stored).toMatch(/^[0-9]{6}$/);
      const result = await verifyOtp(G5_PHONE, stored as string);
      expect(result.valid).toBe(true);
    });
  });

  it("OTP-4: successful verify consumes the OTP and clears the attempt counter", async () => {
    const mem = new MemoryRedis();
    await withProductionRedis(mem, async () => {
      await seedProductionOtp(mem);
      await wrongVerifies(1);
      expect(await mem.get(G5_ATTEMPTS_KEY)).toBe("1");
      const result = await verifyOtp(G5_PHONE, G5_OTP);
      expect(result.valid).toBe(true);
      expect(await mem.get(G5_OTP_KEY)).toBeNull();
      expect(await mem.get(G5_ATTEMPTS_KEY)).toBeNull();
    });
  });

  it("OTP-5: expired or missing OTP still fails as OTP_EXPIRED", async () => {
    const mem = new MemoryRedis();
    await withProductionRedis(mem, async () => {
      await expect(verifyOtp("+919999999999", G5_OTP)).rejects.toMatchObject({
        code: "OTP_EXPIRED",
      });
    });
  });

  it("OTP-6: failed attempts are stored in Redis at otp:attempts:<canonical-phone>", async () => {
    const mem = new MemoryRedis();
    await withProductionRedis(mem, async () => {
      await seedProductionOtp(mem);
      await wrongVerifies(3);
      const storedAttempts = await mem.get(G5_ATTEMPTS_KEY);
      expect(storedAttempts).toBe("3");
      await wrongVerifies(1);
      expect(await mem.get(G5_ATTEMPTS_KEY)).toBe("4");
    });
  });

  it("OTP-7: Redis failure on verify is fail-closed and does not authenticate", async () => {
    const mem = new FailingGetRedis();
    await withProductionRedis(mem, async () => {
      await expect(verifyOtp(G5_PHONE, G5_OTP)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      });
    });
  });

  it("OTP-8: Redis failure while recording a failed attempt is fail-closed", async () => {
    const mem = new FailingAttemptsRedis();
    await withProductionRedis(mem, async () => {
      await seedProductionOtp(mem);
      await expect(verifyOtp(G5_PHONE, G5_WRONG)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      });
      expect(await mem.get(G5_OTP_KEY)).toBe(G5_OTP);
    });
  });
});
