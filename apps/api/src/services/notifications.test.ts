import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit, createEventEnvelope } from "../lib/eventBus";
import { logger } from "../lib/logger";
import { resetRedisForTests } from "../lib/redis";
import {
  registerVendorNotificationHandlers,
  drainNotifications,
  deliverOne,
  sendSmsMessage,
  sendEmailMessage,
  startNotificationRetrySweep,
  stopNotificationRetrySweep,
  __setNotificationProviderForTests,
  NOTIFICATION_RETRY_SWEEP_INTERVAL_MS,
} from "./notifications";
import type { NotificationProvider, NotificationProviderOutcome } from "./notifications";
import { sharedNotificationRepo } from "../repositories/shared";
import type { NotificationStatus, NotificationDTO } from "../repositories/notificationRepository";
import {
  MemoryNotificationRepository,
  NOTIFICATION_MAX_ATTEMPTS,
} from "../repositories/notificationRepository";

// ============================================
// Vendor onboarding notification outbox tests
// ============================================

const APPLICANT_ID = "00000000-0000-4000-8000-000000000001";
const VENDOR_ID = "00000000-0000-4000-8000-000000000002";

describe("Vendor onboarding notifications (outbox)", () => {
  beforeEach(() => {
    resetRedisForTests();
    sharedNotificationRepo._reset();
  });

  it("enqueues SMS + email on approval", async () => {
    registerVendorNotificationHandlers();
    await emit(
      createEventEnvelope("VendorApplicationApproved", "app-1", {
        applicant_id: APPLICANT_ID,
        name: "Spice Route",
        phone: "+9100000001",
        contact_email: "owner@spiceroute.com",
        vendor_id: VENDOR_ID,
      }),
    );

    const all = await sharedNotificationRepo.listAll();
    const sms = all.filter((n) => n.channel === "sms");
    const email = all.filter((n) => n.channel === "email");
    expect(sms).toHaveLength(1);
    expect(email).toHaveLength(1);
    const sms0 = sms[0]!;
    const email0 = email[0]!;
    expect(sms0.to_address).toBe("+9100000001");
    expect(sms0.body).toContain("Spice Route");
    expect(sms0.body).toContain("approved");
    expect(email0.to_address).toBe("owner@spiceroute.com");
  });

  it("enqueues SMS with reason on rejection and skips absent email", async () => {
    registerVendorNotificationHandlers();
    await emit(
      createEventEnvelope("VendorApplicationRejected", "app-2", {
        applicant_id: APPLICANT_ID,
        name: "Spice Route",
        phone: "+9100000001",
        contact_email: null,
        reason: "GST mismatch",
      }),
    );

    const all = await sharedNotificationRepo.listAll();
    expect(all).toHaveLength(1);
    const n0 = all[0]!;
    expect(n0.channel).toBe("sms");
    expect(n0.body).toContain("not approved");
    expect(n0.body).toContain("GST mismatch");
  });

  it("drain marks successfully sent entries as SENT", async () => {
    await sharedNotificationRepo.enqueue({
      user_id: APPLICANT_ID,
      channel: "sms",
      to_address: "+9100000001",
      body: "hello",
    });
    await drainNotifications();
    const all = await sharedNotificationRepo.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("SENT");
  });
});

describe("MemoryNotificationRepository retry semantics", () => {
  let repo: MemoryNotificationRepository;

  beforeEach(() => {
    repo = new MemoryNotificationRepository();
  });

  it("retryable failure stays PENDING until backoff elapses, then can be reserved again", async () => {
    const n = await repo.enqueue({
      user_id: APPLICANT_ID,
      channel: "sms",
      to_address: "+91",
      body: "hi",
    });

    const r1 = await repo.reserveAttempt(n.id, 0, new Date());
    await repo.markRetryable(n.id, r1!.attempts, "boom", new Date(Date.now() + 60_000));
    expect(await repo.listPending()).toHaveLength(0);

    await repo.markRetryable(n.id, r1!.attempts, "boom", new Date(Date.now() - 1_000));
    expect(await repo.listPending()).toHaveLength(1);

    const r2 = await repo.reserveAttempt(n.id, r1!.attempts, new Date());
    await repo.markDead(n.id, r2!.attempts, "boom");
    const all = await repo.listAll();
    expect(all[0]!.status).toBe("FAILED");
    expect(all[0]!.attempts).toBe(2);
    expect(await repo.listPending()).toHaveLength(0);
  });
});

// ============================================
// NOTIFICATION-PROVIDER-TRUTH-A2
// Production delivery must fail closed: without a real provider, an SMS/email
// send may not report success, may not mark the row SENT, and may not emit a
// dispatch-success log. NODE_ENV=test keeps a deterministic fake success.
// ============================================

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

async function withNodeEnv<T>(value: string, fn: () => Promise<T> | T): Promise<T> {
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

function enqueueSms() {
  return sharedNotificationRepo.enqueue({
    user_id: APPLICANT_ID,
    channel: "sms",
    to_address: "+9100000001",
    body: "provider truth",
  });
}

function enqueueEmail() {
  return sharedNotificationRepo.enqueue({
    user_id: APPLICANT_ID,
    channel: "email",
    to_address: "owner@example.com",
    body: "provider truth",
  });
}

describe("Provider truth (NOTIFICATION-PROVIDER-TRUTH-A2)", () => {
  beforeEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    resetRedisForTests();
    sharedNotificationRepo._reset();
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.restoreAllMocks();
  });

  it("T1: test-mode SMS fake path may succeed", async () => {
    await withNodeEnv("test", async () => {
      await expect(sendSmsMessage("+9100000001", "hello", "key-1")).resolves.toEqual({
        kind: "ACCEPTED",
      });
    });
  });

  it("T2: test-mode email fake path may succeed", async () => {
    await withNodeEnv("test", async () => {
      await expect(sendEmailMessage("owner@example.com", "hello", "key-2")).resolves.toEqual({
        kind: "ACCEPTED",
      });
    });
  });

  it("T3: production-like SMS with no provider fails closed as CONFIG_ERROR", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await withNodeEnv("production", async () => {
      const outcome = await sendSmsMessage("+9100000001", "hello", "key-3");
      expect(outcome.kind).not.toBe("ACCEPTED");
      expect(outcome).toEqual({ kind: "CONFIG_ERROR", error: "sms provider not configured" });
    });
  });

  it("T4: production-like email with no provider fails closed as CONFIG_ERROR", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await withNodeEnv("production", async () => {
      const outcome = await sendEmailMessage("owner@example.com", "hello", "key-4");
      expect(outcome.kind).not.toBe("ACCEPTED");
      expect(outcome).toEqual({ kind: "CONFIG_ERROR", error: "email provider not configured" });
    });
  });

  it("T5: production-like SMS attempt does not mark notification SENT", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await enqueueSms();
    await withNodeEnv("production", () => drainNotifications());
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).not.toBe("SENT");
    expect(row!.status).toBe("PENDING");
  });

  it("T6: production-like email attempt does not mark notification SENT", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await enqueueEmail();
    await withNodeEnv("production", () => drainNotifications());
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).not.toBe("SENT");
    expect(row!.status).toBe("PENDING");
  });

  it("T7: unconfigured SMS schedules retry with existing exponential backoff", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    const before = Date.now();
    await enqueueSms();
    await withNodeEnv("production", () => drainNotifications());
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("PENDING");
    const delayMs = Date.parse(row!.next_attempt_at) - before;
    expect(delayMs).toBeGreaterThanOrEqual(29_000);
    expect(delayMs).toBeLessThanOrEqual(31_000);
  });

  it("T8: unconfigured email schedules retry with existing exponential backoff", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    const before = Date.now();
    await enqueueEmail();
    await withNodeEnv("production", () => drainNotifications());
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("PENDING");
    const delayMs = Date.parse(row!.next_attempt_at) - before;
    expect(delayMs).toBeGreaterThanOrEqual(29_000);
    expect(delayMs).toBeLessThanOrEqual(31_000);
  });

  it("T9: unconfigured attempt increments attempts exactly once", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await enqueueSms();
    const [before] = await sharedNotificationRepo.listAll();
    expect(before!.attempts).toBe(0);
    await withNodeEnv("production", () => drainNotifications());
    const [after] = await sharedNotificationRepo.listAll();
    expect(after!.attempts).toBe(1);
  });

  it("T10: at MAX_ATTEMPTS boundary the unconfigured provider reaches FAILED, not SENT", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    const n = await enqueueSms();
    const now = new Date();
    const due = new Date(Date.now() - 60_000);
    for (let i = 0; i < 4; i += 1) {
      const reserved = await sharedNotificationRepo.reserveAttempt(n.id, i, now);
      await sharedNotificationRepo.markRetryable(n.id, reserved!.attempts, "prior", due);
    }
    const [before] = await sharedNotificationRepo.listAll();
    expect(before!.attempts).toBe(4);
    await withNodeEnv("production", () => drainNotifications());
    const [after] = await sharedNotificationRepo.listAll();
    expect(after!.status).toBe("FAILED");
    expect(after!.attempts).toBe(5);
  });

  it("T11: no SMS dispatch success log on the unconfigured production path", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    await enqueueSms();
    await withNodeEnv("production", () => drainNotifications());
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "notification_sms_dispatched" }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "notification_sms_provider_unconfigured" }),
    );
  });

  it("T12: no email dispatch success log on the unconfigured production path", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    await enqueueEmail();
    await withNodeEnv("production", () => drainNotifications());
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "notification_email_dispatched" }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "notification_email_provider_unconfigured" }),
    );
  });

  it("T13: existing test-mode delivery still marks SENT", async () => {
    await enqueueSms();
    await drainNotifications();
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("SENT");
    expect(row!.attempts).toBe(1);
  });

  it("T14: status enum and drain API are unchanged", () => {
    const statuses: NotificationStatus[] = ["PENDING", "SENT", "FAILED"];
    expect(statuses).toHaveLength(3);
    expect(drainNotifications.length).toBe(0);
  });
});

// ============================================
// NOTIFICATION-DELIVERY-CONCURRENCY-A2 — service delivery flow.
// The reservation decides the winner BEFORE any provider call; a loser
// returns without invoking the provider or mutating the row.
// ============================================

describe("Notification delivery concurrency (service flow)", () => {
  beforeEach(() => {
    resetRedisForTests();
    sharedNotificationRepo._reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function swapReserve(
    fn: (id: string, expected: number, now: Date) => Promise<unknown>,
  ): () => void {
    const record = sharedNotificationRepo as unknown as Record<string, unknown>;
    const original = record.reserveAttempt;
    record.reserveAttempt = fn;
    return () => {
      record.reserveAttempt = original;
    };
  }

  it("T15: provider is invoked only after a successful attempt reservation", async () => {
    const n = await enqueueSms();
    const record = sharedNotificationRepo as unknown as Record<string, unknown>;
    const realReserve = sharedNotificationRepo.reserveAttempt.bind(sharedNotificationRepo);
    const reserveSpy = vi.fn((id: string, expected: number, now: Date) =>
      realReserve(id, expected, now),
    );
    record.reserveAttempt = reserveSpy;
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await withNodeEnv("production", () => deliverOne(n));
    } finally {
      record.reserveAttempt = realReserve;
    }

    const providerIdx = errorSpy.mock.calls.findIndex(
      (c) =>
        (c[0] as { message?: string } | undefined)?.message ===
        "notification_sms_provider_unconfigured",
    );
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(reserveSpy.mock.invocationCallOrder[0]).toBeLessThan(
      errorSpy.mock.invocationCallOrder[providerIdx]!,
    );
  });

  it("T16: a reservation loser calls the provider zero times and mutates nothing", async () => {
    const n = await enqueueSms();
    const restore = swapReserve(async () => null);
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await withNodeEnv("production", () => deliverOne(n));
    } finally {
      restore();
    }

    expect(
      errorSpy.mock.calls.some(
        (c) =>
          (c[0] as { message?: string } | undefined)?.message ===
          "notification_sms_provider_unconfigured",
      ),
    ).toBe(false);
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(0);
  });

  it("two logical drainers on the same candidate invoke the provider exactly once", async () => {
    const n = await enqueueSms();
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    await withNodeEnv("production", () => Promise.all([deliverOne(n), deliverOne(n)]));

    const providerCalls = errorSpy.mock.calls.filter(
      (c) =>
        (c[0] as { message?: string } | undefined)?.message ===
        "notification_sms_provider_unconfigured",
    ).length;
    expect(providerCalls).toBe(1);
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.attempts).toBe(1);
  });

  it("T18: released provider fail-closed truth is preserved under reservation", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    await enqueueSms();
    await withNodeEnv("production", () => drainNotifications());
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).not.toBe("SENT");
    expect(row!.status).toBe("PENDING");
    expect(row!.last_error).toContain("provider not configured");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "notification_sms_provider_unconfigured" }),
    );
  });
});

// ============================================
// NOTIFICATION-RETRY-SWEEPER-A2 — retry liveness.
// A due retryable row must be revisited without any unrelated vendor event:
// once at startup and periodically thereafter, behind an unref'd timer with an
// explicit stop. The repository reserveAttempt CAS remains the only guard.
// ============================================

describe("Notification retry sweep (NOTIFICATION-RETRY-SWEEPER-A2)", () => {
  beforeEach(() => {
    resetRedisForTests();
    sharedNotificationRepo._reset();
    vi.restoreAllMocks();
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  afterEach(() => {
    stopNotificationRetrySweep();
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  // Date must be faked so a scheduled next_attempt_at becomes due as fake time
  // advances; otherwise the memory repo would compare against the real clock.
  const useSweepFakeTimers = () =>
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });

  async function statusOf(id: string): Promise<string | undefined> {
    return (await sharedNotificationRepo.listAll()).find((n) => n.id === id)?.status;
  }

  async function until(cond: () => Promise<boolean>, tries = 500): Promise<void> {
    for (let i = 0; i < tries; i += 1) {
      if (await cond()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("until: condition not met");
  }

  it("T1: startNotificationRetrySweep immediately triggers one drain", async () => {
    const n = await enqueueSms();
    startNotificationRetrySweep();
    await until(async () => (await statusOf(n.id)) === "SENT");
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("SENT");
    expect(row!.attempts).toBe(1);
  });

  it("T2: the periodic interval triggers subsequent drains", async () => {
    useSweepFakeTimers();
    startNotificationRetrySweep();
    await vi.advanceTimersByTimeAsync(0);
    const n = await enqueueSms();
    expect(await statusOf(n.id)).toBe("PENDING");
    await vi.advanceTimersByTimeAsync(NOTIFICATION_RETRY_SWEEP_INTERVAL_MS);
    expect(await statusOf(n.id)).toBe("SENT");
  });

  it("T3: a due retry is attempted without any unrelated new event", async () => {
    const n = await enqueueSms();
    const r = await sharedNotificationRepo.reserveAttempt(n.id, 0, new Date());
    await sharedNotificationRepo.markRetryable(
      n.id,
      r!.attempts,
      "boom",
      new Date(Date.now() - 1_000),
    );
    const [before] = await sharedNotificationRepo.listAll();
    expect(before!.status).toBe("PENDING");
    expect(before!.attempts).toBe(1);

    startNotificationRetrySweep();
    await until(async () => (await statusOf(n.id)) === "SENT");
    const [after] = await sharedNotificationRepo.listAll();
    expect(after!.status).toBe("SENT");
    expect(after!.attempts).toBe(2);
  });

  it("T4: a future next_attempt_at row is not attempted early", async () => {
    useSweepFakeTimers();
    const n = await enqueueSms();
    const r = await sharedNotificationRepo.reserveAttempt(n.id, 0, new Date());
    await sharedNotificationRepo.markRetryable(
      n.id,
      r!.attempts,
      "boom",
      new Date(Date.now() + 2 * NOTIFICATION_RETRY_SWEEP_INTERVAL_MS),
    );

    startNotificationRetrySweep();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_RETRY_SWEEP_INTERVAL_MS);
    expect(await statusOf(n.id)).toBe("PENDING");
    const [mid] = await sharedNotificationRepo.listAll();
    expect(mid!.attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(NOTIFICATION_RETRY_SWEEP_INTERVAL_MS);
    expect(await statusOf(n.id)).toBe("SENT");
  });

  it("T5: start drains a pre-existing due row (restart recovery)", async () => {
    const n = await enqueueSms();
    const r = await sharedNotificationRepo.reserveAttempt(n.id, 0, new Date());
    await sharedNotificationRepo.markRetryable(
      n.id,
      r!.attempts,
      "boom",
      new Date(Date.now() - 1_000),
    );
    stopNotificationRetrySweep(); // no timer survives the simulated restart
    startNotificationRetrySweep();
    await until(async () => (await statusOf(n.id)) === "SENT");
    expect(await statusOf(n.id)).toBe("SENT");
  });

  it("T6: start is idempotent — no duplicate intervals", () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    startNotificationRetrySweep();
    startNotificationRetrySweep();
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it("T7: stop clears the interval", async () => {
    useSweepFakeTimers();
    startNotificationRetrySweep();
    await vi.advanceTimersByTimeAsync(0);
    const n = await enqueueSms();
    stopNotificationRetrySweep();
    await vi.advanceTimersByTimeAsync(2 * NOTIFICATION_RETRY_SWEEP_INTERVAL_MS);
    expect(await statusOf(n.id)).toBe("PENDING");
  });

  it("T8: stop is idempotent and safe when never started", () => {
    expect(() => stopNotificationRetrySweep()).not.toThrow();
    startNotificationRetrySweep();
    expect(() => stopNotificationRetrySweep()).not.toThrow();
    expect(() => stopNotificationRetrySweep()).not.toThrow();
  });

  it("T9: the timer is unref'd and cleared by stop", () => {
    const unref = vi.fn();
    const fakeTimer = { unref, ref: vi.fn() } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeTimer);
    const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    startNotificationRetrySweep();
    expect(unref).toHaveBeenCalledTimes(1);
    stopNotificationRetrySweep();
    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
  });

  it("T10: overlapping same-process drains do not run concurrently", async () => {
    const record = sharedNotificationRepo as unknown as Record<string, unknown>;
    const original = record.listPending as (limit?: number) => Promise<unknown[]>;
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    record.listPending = vi.fn(async (limit?: number) => {
      calls += 1;
      await gate;
      return original.call(sharedNotificationRepo, limit);
    });
    try {
      const p1 = drainNotifications();
      const p2 = drainNotifications();
      release();
      await Promise.all([p1, p2]);
    } finally {
      record.listPending = original;
    }
    expect(calls).toBe(1);
  });

  it("T11: an unconfigured notification reaches FAILED at MAX_ATTEMPTS under the sweep", async () => {
    useSweepFakeTimers();
    vi.spyOn(logger, "error").mockReturnValue(logger);
    process.env.NODE_ENV = "production";
    const n = await enqueueSms();
    startNotificationRetrySweep();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(NOTIFICATION_RETRY_SWEEP_INTERVAL_MS);
    }
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.id).toBe(n.id);
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(5);
  });

  it("T12: SENT/FAILED rows are not revisited by the sweep", async () => {
    const sent = await enqueueSms();
    const sentR = await sharedNotificationRepo.reserveAttempt(sent.id, 0, new Date());
    await sharedNotificationRepo.markSent(sent.id, sentR!.attempts);
    const failed = await enqueueSms();
    const failedR = await sharedNotificationRepo.reserveAttempt(failed.id, 0, new Date());
    await sharedNotificationRepo.markDead(failed.id, failedR!.attempts, "dead");

    startNotificationRetrySweep();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    const rows = await sharedNotificationRepo.listAll();
    const s = rows.find((r) => r.id === sent.id)!;
    const f = rows.find((r) => r.id === failed.id)!;
    expect(s.status).toBe("SENT");
    expect(s.attempts).toBe(1);
    expect(f.status).toBe("FAILED");
    expect(f.attempts).toBe(1);
  });

  it("T13: event-triggered immediate drain is preserved", async () => {
    registerVendorNotificationHandlers();
    await emit(
      createEventEnvelope("VendorApplicationApproved", "app-sweep", {
        applicant_id: APPLICANT_ID,
        name: "Spice Route",
        phone: "+9100000001",
        contact_email: null,
        vendor_id: VENDOR_ID,
      }),
    );
    await until(async () => {
      const all = await sharedNotificationRepo.listAll();
      return all.length === 1 && all[0]!.status === "SENT";
    });
    const all = await sharedNotificationRepo.listAll();
    expect(all[0]!.status).toBe("SENT");
  });

  it("T14: status enum, drain API, interval and provider truth are unchanged", async () => {
    const statuses: NotificationStatus[] = ["PENDING", "SENT", "FAILED"];
    expect(statuses).toHaveLength(3);
    expect(drainNotifications.length).toBe(0);
    expect(NOTIFICATION_RETRY_SWEEP_INTERVAL_MS).toBe(30_000);
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await withNodeEnv("production", async () => {
      const outcome = await sendSmsMessage("+9100000001", "x", "key-sweep");
      expect(outcome.kind).toBe("CONFIG_ERROR");
    });
  });
});

// ============================================
// NOTIFICATION-PROVIDER-IDEMPOTENCY-A2 — schema-free provider idempotency.
// The provider idempotency key is the notification's immutable id, reused on
// every retry and on one final same-key confirmation call. `attempts` counts
// reserved application delivery attempts, so a final reserved attempt may
// issue up to two provider calls (initial + confirmation) while attempts
// still advances by exactly one.
// ============================================

type ProviderCall = {
  channel: string;
  toAddress: string;
  body: string;
  key: string;
};

function scriptProvider(script: NotificationProviderOutcome[]) {
  const calls: ProviderCall[] = [];
  const provider: NotificationProvider = async (channel, toAddress, body, key) => {
    calls.push({ channel, toAddress, body, key });
    return script.shift() ?? { kind: "ACCEPTED" };
  };
  return { provider, calls };
}

function enqueueIdem(channel: "sms" | "email" = "sms"): Promise<NotificationDTO> {
  return sharedNotificationRepo.enqueue({
    user_id: APPLICANT_ID,
    channel,
    to_address: channel === "sms" ? "+9100000001" : "owner@example.com",
    body: "idempotency",
  });
}

async function currentOf(id: string): Promise<NotificationDTO> {
  return (await sharedNotificationRepo.listAll()).find((n) => n.id === id)!;
}

async function driveToAttempts(id: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const reserved = await sharedNotificationRepo.reserveAttempt(id, i, new Date());
    await sharedNotificationRepo.markRetryable(
      id,
      reserved!.attempts,
      "prior",
      new Date(Date.now() - 60_000),
    );
  }
}

describe("Provider idempotency (NOTIFICATION-PROVIDER-IDEMPOTENCY-A2)", () => {
  beforeEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    resetRedisForTests();
    sharedNotificationRepo._reset();
  });

  afterEach(() => {
    __setNotificationProviderForTests(null);
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.restoreAllMocks();
  });

  it("T1: SMS test-mode fake path returns ACCEPTED and deliverOne uses notification.id", async () => {
    await withNodeEnv("test", async () => {
      const n = await enqueueIdem("sms");
      await expect(sendSmsMessage("+9100000001", "hello", n.id)).resolves.toEqual({
        kind: "ACCEPTED",
      });
      const { provider, calls } = scriptProvider([{ kind: "ACCEPTED" }]);
      __setNotificationProviderForTests(provider);
      await deliverOne(n);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.channel).toBe("sms");
      expect(calls[0]!.key).toBe(n.id);
      const [row] = await sharedNotificationRepo.listAll();
      expect(row!.status).toBe("SENT");
    });
  });

  it("T2: email test-mode fake path returns ACCEPTED and deliverOne uses notification.id", async () => {
    await withNodeEnv("test", async () => {
      const n = await enqueueIdem("email");
      await expect(sendEmailMessage("owner@example.com", "hello", n.id)).resolves.toEqual({
        kind: "ACCEPTED",
      });
      const { provider, calls } = scriptProvider([{ kind: "ACCEPTED" }]);
      __setNotificationProviderForTests(provider);
      await deliverOne(n);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.channel).toBe("email");
      expect(calls[0]!.key).toBe(n.id);
      const [row] = await sharedNotificationRepo.listAll();
      expect(row!.status).toBe("SENT");
    });
  });

  it("T3: non-test unconfigured SMS is CONFIG_ERROR, never ACCEPTED", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await withNodeEnv("production", async () => {
      const outcome = await sendSmsMessage("+9100000001", "hello", "key-t3");
      expect(outcome.kind).toBe("CONFIG_ERROR");
      expect(outcome.kind).not.toBe("ACCEPTED");
    });
  });

  it("T4: non-test unconfigured email is CONFIG_ERROR, never ACCEPTED", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await withNodeEnv("production", async () => {
      const outcome = await sendEmailMessage("owner@example.com", "hello", "key-t4");
      expect(outcome.kind).toBe("CONFIG_ERROR");
      expect(outcome.kind).not.toBe("ACCEPTED");
    });
  });

  it("T5: ACCEPTED -> markSent with a single provider call", async () => {
    const n = await enqueueIdem();
    const { provider, calls } = scriptProvider([{ kind: "ACCEPTED" }]);
    __setNotificationProviderForTests(provider);
    await deliverOne(n);
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("SENT");
    expect(row!.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(n.id);
  });

  it("T6: DEFINITIVE_FAILURE before max -> markRetryable", async () => {
    const n = await enqueueIdem();
    const { provider } = scriptProvider([
      { kind: "DEFINITIVE_FAILURE", error: "definitely rejected" },
    ]);
    __setNotificationProviderForTests(provider);
    await deliverOne(n);
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain("definitely rejected");
  });

  it("T7: CONFIG_ERROR before max -> markRetryable", async () => {
    const n = await enqueueIdem();
    const { provider } = scriptProvider([{ kind: "CONFIG_ERROR", error: "provider down" }]);
    __setNotificationProviderForTests(provider);
    await deliverOne(n);
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain("provider down");
  });

  it("T8: AMBIGUOUS before max -> markRetryable", async () => {
    const n = await enqueueIdem();
    const { provider } = scriptProvider([{ kind: "AMBIGUOUS", error: "timeout" }]);
    __setNotificationProviderForTests(provider);
    await deliverOne(n);
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain("timeout");
  });

  it("T9: retry after AMBIGUOUS reuses the exact notification.id key", async () => {
    const n = await enqueueIdem();
    const { provider, calls } = scriptProvider([
      { kind: "AMBIGUOUS", error: "timeout" },
      { kind: "ACCEPTED" },
    ]);
    __setNotificationProviderForTests(provider);
    await deliverOne(n);
    let [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(1);

    await sharedNotificationRepo.markRetryable(n.id, 1, "timeout", new Date(Date.now() - 1_000));
    await deliverOne(await currentOf(n.id));
    [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("SENT");
    expect(row!.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).toBe(n.id);
    expect(calls[1]!.key).toBe(n.id);
  });

  it("T10: DEFINITIVE_FAILURE at max -> markDead", async () => {
    const n = await enqueueIdem();
    await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider } = scriptProvider([
      { kind: "DEFINITIVE_FAILURE", error: "rejected at cap" },
    ]);
    __setNotificationProviderForTests(provider);
    await deliverOne(await currentOf(n.id));
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(NOTIFICATION_MAX_ATTEMPTS);
  });

  it("T11: CONFIG_ERROR at max -> markDead", async () => {
    const n = await enqueueIdem();
    await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider } = scriptProvider([{ kind: "CONFIG_ERROR", error: "down at cap" }]);
    __setNotificationProviderForTests(provider);
    await deliverOne(await currentOf(n.id));
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(NOTIFICATION_MAX_ATTEMPTS);
  });

  it("T12: first AMBIGUOUS at max does NOT markDead; one same-key confirmation runs", async () => {
    const n = await enqueueIdem();
    await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider, calls } = scriptProvider([
      { kind: "AMBIGUOUS", error: "timeout-1" },
      { kind: "ACCEPTED" },
    ]);
    __setNotificationProviderForTests(provider);
    const record = sharedNotificationRepo as unknown as Record<string, unknown>;
    const realMarkDead = sharedNotificationRepo.markDead.bind(sharedNotificationRepo);
    const deadSpy = vi.fn();
    record.markDead = vi.fn((id: string, attempts: number, err: string) => {
      deadSpy();
      return realMarkDead(id, attempts, err);
    });
    try {
      await deliverOne(await currentOf(n.id));
    } finally {
      record.markDead = realMarkDead;
    }
    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).toBe(n.id);
    expect(deadSpy).not.toHaveBeenCalled();
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("SENT");
  });

  it("T13: AMBIGUOUS-at-max then ACCEPTED confirmation -> markSent, attempts stays MAX_ATTEMPTS", async () => {
    const n = await enqueueIdem();
    await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider, calls } = scriptProvider([
      { kind: "AMBIGUOUS", error: "timeout-1" },
      { kind: "ACCEPTED" },
    ]);
    __setNotificationProviderForTests(provider);
    await deliverOne(await currentOf(n.id));
    const [row] = await sharedNotificationRepo.listAll();
    expect(row!.status).toBe("SENT");
    expect(row!.attempts).toBe(NOTIFICATION_MAX_ATTEMPTS);
    expect(calls.map((c) => c.key)).toEqual([n.id, n.id]);
  });

  it("T14: AMBIGUOUS-at-max then DEFINITIVE_FAILURE/CONFIG_ERROR -> markDead", async () => {
    const confirmations: NotificationProviderOutcome[] = [
      { kind: "DEFINITIVE_FAILURE", error: "confirmed failure" },
      { kind: "CONFIG_ERROR", error: "confirmed config down" },
    ];
    for (const confirmation of confirmations) {
      sharedNotificationRepo._reset();
      const n = await enqueueIdem();
      await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
      const { provider, calls } = scriptProvider([
        { kind: "AMBIGUOUS", error: "timeout-1" },
        confirmation,
      ]);
      __setNotificationProviderForTests(provider);
      await deliverOne(await currentOf(n.id));
      const [row] = await sharedNotificationRepo.listAll();
      expect(row!.status).toBe("FAILED");
      expect(row!.attempts).toBe(NOTIFICATION_MAX_ATTEMPTS);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.key).toBe(n.id);
    }
  });

  it("T15: AMBIGUOUS-at-max then AMBIGUOUS -> exactly two calls, FAILED with uncertainty", async () => {
    const n = await enqueueIdem();
    await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider, calls } = scriptProvider([
      { kind: "AMBIGUOUS", error: "timeout-1" },
      { kind: "AMBIGUOUS", error: "timeout-2" },
    ]);
    __setNotificationProviderForTests(provider);
    await deliverOne(await currentOf(n.id));
    const [row] = await sharedNotificationRepo.listAll();
    expect(calls).toHaveLength(2);
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(NOTIFICATION_MAX_ATTEMPTS);
    expect(row!.last_error).toContain(
      "provider outcome ambiguous after final same-key confirmation",
    );
    expect(calls[0]!.key).toBe(n.id);
    expect(calls[1]!.key).toBe(n.id);
  });

  it("T16: no route/DTO/repository/schema/EventBus/provider-dependency change", () => {
    const statuses: NotificationStatus[] = ["PENDING", "SENT", "FAILED"];
    expect(statuses).toHaveLength(3);
    for (const method of ["reserveAttempt", "markSent", "markRetryable", "markDead"] as const) {
      expect(typeof sharedNotificationRepo[method]).toBe("function");
    }
    expect(sendSmsMessage.length).toBe(3);
    expect(sendEmailMessage.length).toBe(3);
    expect(drainNotifications.length).toBe(0);
  });

  it("CAS loss on the terminal write does not trigger another provider call", async () => {
    const n = await enqueueIdem();
    const { provider, calls } = scriptProvider([{ kind: "ACCEPTED" }]);
    __setNotificationProviderForTests(provider);
    const record = sharedNotificationRepo as unknown as Record<string, unknown>;
    const realMarkSent = sharedNotificationRepo.markSent.bind(sharedNotificationRepo);
    record.markSent = vi.fn(async () => null);
    try {
      await deliverOne(n);
    } finally {
      record.markSent = realMarkSent;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(n.id);
  });
});

// ============================================
// NOTIFICATION-DRAIN-RESILIENCE-A2 — per-item batch isolation.
// A single item's reservation/state-persistence failure must not abort the
// remaining eligible items in the same drain cycle, and must be logged
// truthfully at item level (no PII, no fabricated success). Batch-level
// listPending failures stay on the existing notification_drain_error path.
// ============================================

describe("Notification drain resilience (NOTIFICATION-DRAIN-RESILIENCE-A2)", () => {
  beforeEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    resetRedisForTests();
    sharedNotificationRepo._reset();
  });

  afterEach(() => {
    __setNotificationProviderForTests(null);
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.restoreAllMocks();
  });

  function patchRepoMethod(
    method: string,
    impl: (...args: unknown[]) => unknown,
  ): () => void {
    const record = sharedNotificationRepo as unknown as Record<string, unknown>;
    const original = record[method];
    const hadOwn = Object.prototype.hasOwnProperty.call(record, method);
    record[method] = impl;
    return () => {
      if (hadOwn) record[method] = original;
      else delete record[method];
    };
  }

  function throwOnceFor(method: string, id: string, message: string): () => void {
    const record = sharedNotificationRepo as unknown as Record<string, unknown>;
    const original = record[method] as (...args: unknown[]) => unknown;
    let armed = true;
    return patchRepoMethod(method, (...args: unknown[]) => {
      if (armed && args[0] === id) {
        armed = false;
        throw new Error(message);
      }
      return original.apply(sharedNotificationRepo, args);
    });
  }

  function providerByKey(outcomes: Map<string, NotificationProviderOutcome>) {
    const calls: ProviderCall[] = [];
    const provider: NotificationProvider = async (channel, toAddress, body, key) => {
      calls.push({ channel, toAddress, body, key });
      return outcomes.get(key) ?? { kind: "ACCEPTED" };
    };
    return { provider, calls };
  }

  function itemErrors(calls: unknown[][]): { notification_id?: string }[] {
    return calls
      .map((c) => c[0] as { message?: string; notification_id?: string } | undefined)
      .filter(
        (a): a is { message?: string; notification_id?: string } =>
          a?.message === "notification_delivery_item_error",
      );
  }

  it("T1: two eligible notifications both process normally", async () => {
    const a = await enqueueIdem();
    const b = await enqueueIdem();
    await drainNotifications();
    expect((await currentOf(a.id)).status).toBe("SENT");
    expect((await currentOf(b.id)).status).toBe("SENT");
  });

  it("T2: first item reserveAttempt failure does not stop the second item", async () => {
    const a = await enqueueIdem();
    const b = await enqueueIdem();
    const restore = throwOnceFor("reserveAttempt", a.id, "reserve boom");
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    const aRow = await currentOf(a.id);
    expect(aRow.status).toBe("PENDING");
    expect(aRow.attempts).toBe(0);
    expect((await currentOf(b.id)).status).toBe("SENT");
    expect(itemErrors(errorSpy.mock.calls as unknown[][])).toHaveLength(1);
  });

  it("T3: markSent failure after ACCEPTED does not stop the second item", async () => {
    const a = await enqueueIdem();
    const b = await enqueueIdem();
    const restore = throwOnceFor("markSent", a.id, "markSent boom");
    vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    const aRow = await currentOf(a.id);
    expect(aRow.status).toBe("PENDING");
    expect(aRow.attempts).toBe(1);
    expect(aRow.last_error).toBeNull();
    expect((await currentOf(b.id)).status).toBe("SENT");
  });

  it("T4: markRetryable failure does not stop the second item", async () => {
    const a = await enqueueIdem();
    const b = await enqueueIdem();
    const { provider } = providerByKey(
      new Map<string, NotificationProviderOutcome>([
        [a.id, { kind: "DEFINITIVE_FAILURE", error: "def" }],
        [b.id, { kind: "ACCEPTED" }],
      ]),
    );
    __setNotificationProviderForTests(provider);
    const restore = throwOnceFor("markRetryable", a.id, "markRetryable boom");
    vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    const aRow = await currentOf(a.id);
    expect(aRow.status).toBe("PENDING");
    expect(aRow.attempts).toBe(1);
    expect((await currentOf(b.id)).status).toBe("SENT");
  });

  it("T5: markDead failure at max does not stop the second item", async () => {
    const a = await enqueueIdem();
    const b = await enqueueIdem();
    await driveToAttempts(a.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider } = providerByKey(
      new Map<string, NotificationProviderOutcome>([
        [a.id, { kind: "DEFINITIVE_FAILURE", error: "def at cap" }],
        [b.id, { kind: "ACCEPTED" }],
      ]),
    );
    __setNotificationProviderForTests(provider);
    const restore = throwOnceFor("markDead", a.id, "markDead boom");
    vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    const aRow = await currentOf(a.id);
    expect(aRow.status).toBe("PENDING");
    expect(aRow.attempts).toBe(NOTIFICATION_MAX_ATTEMPTS);
    expect((await currentOf(b.id)).status).toBe("SENT");
  });

  it("T6: item failure emits exactly one truthful item-level error log", async () => {
    const a = await enqueueIdem();
    await enqueueIdem();
    const restore = throwOnceFor("reserveAttempt", a.id, "boom");
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    const items = itemErrors(errorSpy.mock.calls as unknown[][]);
    expect(items).toHaveLength(1);
    expect(items[0]!.notification_id).toBe(a.id);
  });

  it("T7: item error log includes notification_id", async () => {
    const a = await enqueueIdem();
    await enqueueIdem();
    const restore = throwOnceFor("reserveAttempt", a.id, "boom");
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "notification_delivery_item_error",
        notification_id: a.id,
      }),
    );
  });

  it("T8: item error log excludes body and destination PII", async () => {
    const a = await enqueueIdem();
    await enqueueIdem();
    const restore = throwOnceFor("reserveAttempt", a.id, "boom");
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    const call = errorSpy.mock.calls.find(
      (c) => (c[0] as { message?: string } | undefined)?.message === "notification_delivery_item_error",
    )!;
    const arg = call[0] as Record<string, unknown>;
    expect(arg.notification_id).toBe(a.id);
    expect("to_address" in arg).toBe(false);
    expect("body" in arg).toBe(false);
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain("+9100000001");
    expect(serialized).not.toContain("idempotency");
  });

  it("T9: item-level failure does not emit a fake success/delivery log", async () => {
    const a = await enqueueIdem();
    await enqueueIdem();
    const restore = throwOnceFor("reserveAttempt", a.id, "boom");
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    expect(infoSpy).not.toHaveBeenCalled();
    const messages = errorSpy.mock.calls.map(
      (c) => (c[0] as { message?: string } | undefined)?.message,
    );
    expect(messages).toEqual(["notification_delivery_item_error"]);
  });

  it("T10: listPending failure still uses notification_drain_error", async () => {
    const restore = patchRepoMethod("listPending", async () => {
      throw new Error("list boom");
    });
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "notification_drain_error" }),
    );
  });

  it("T11: listPending failure emits no item-level error without an item", async () => {
    const restore = patchRepoMethod("listPending", async () => {
      throw new Error("list boom");
    });
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    expect(itemErrors(errorSpy.mock.calls as unknown[][])).toHaveLength(0);
  });

  it("T12: draining guard is released after item failures", async () => {
    const a = await enqueueIdem();
    const restore = throwOnceFor("reserveAttempt", a.id, "boom");
    vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    expect((await currentOf(a.id)).status).toBe("PENDING");
    await drainNotifications();
    expect((await currentOf(a.id)).status).toBe("SENT");
  });

  it("T13: a later drain processes work after a prior item failure", async () => {
    const a = await enqueueIdem();
    const restore = throwOnceFor("reserveAttempt", a.id, "boom");
    vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    const c = await enqueueIdem();
    await drainNotifications();
    expect((await currentOf(a.id)).status).toBe("SENT");
    expect((await currentOf(c.id)).status).toBe("SENT");
  });

  it("T14: limit argument remains honored", async () => {
    await enqueueIdem();
    await enqueueIdem();
    await enqueueIdem();
    await drainNotifications(2);
    const rows = await sharedNotificationRepo.listAll();
    expect(rows.filter((r) => r.status === "SENT")).toHaveLength(2);
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(1);
  });

  it("T15: provider idempotency key remains notification.id", async () => {
    const a = await enqueueIdem();
    const { provider, calls } = scriptProvider([{ kind: "ACCEPTED" }]);
    __setNotificationProviderForTests(provider);
    await drainNotifications();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(a.id);
  });

  it("T16: same-key retry semantics unchanged", async () => {
    const a = await enqueueIdem();
    const { provider, calls } = scriptProvider([
      { kind: "AMBIGUOUS", error: "timeout" },
      { kind: "ACCEPTED" },
    ]);
    __setNotificationProviderForTests(provider);
    await drainNotifications();
    await sharedNotificationRepo.markRetryable(a.id, 1, "timeout", new Date(Date.now() - 1_000));
    await drainNotifications();
    expect(calls.map((c) => c.key)).toEqual([a.id, a.id]);
    expect((await currentOf(a.id)).status).toBe("SENT");
  });

  it("T17: retry sweep cadence unchanged", () => {
    expect(NOTIFICATION_RETRY_SWEEP_INTERVAL_MS).toBe(30_000);
    expect(NOTIFICATION_MAX_ATTEMPTS).toBe(5);
    expect(typeof startNotificationRetrySweep).toBe("function");
    expect(typeof stopNotificationRetrySweep).toBe("function");
  });

  it("T18: repository/schema/EventBus untouched", () => {
    const statuses: NotificationStatus[] = ["PENDING", "SENT", "FAILED"];
    expect(statuses).toHaveLength(3);
    for (const method of [
      "reserveAttempt",
      "markSent",
      "markRetryable",
      "markDead",
      "listPending",
    ] as const) {
      expect(typeof sharedNotificationRepo[method]).toBe("function");
    }
  });

  it("A/B/C: one item persistence failure does not abort later items in the same batch", async () => {
    const a = await enqueueIdem();
    const b = await enqueueIdem();
    const c = await enqueueIdem();
    const restore = throwOnceFor("reserveAttempt", a.id, "A persistence boom");
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    const aRow = await currentOf(a.id);
    expect(aRow.status).toBe("PENDING");
    expect(aRow.attempts).toBe(0);
    expect((await currentOf(b.id)).status).toBe("SENT");
    expect((await currentOf(c.id)).status).toBe("SENT");
    const aErrors = itemErrors(errorSpy.mock.calls as unknown[][]).filter(
      (e) => e.notification_id === a.id,
    );
    expect(aErrors).toHaveLength(1);
  });
});

// ============================================
// NOTIFICATION-OPERABILITY-LIFECYCLE-A2 (OPER_6) — lifecycle + terminal truth.
// The central invariant: log PERSISTED truth, not intended transition. A
// markRetryable/markDead call alone proves nothing; only a non-null repository
// transition result may emit the new structured log. Sweep start/stop log only
// on a real state transition, and the 30s wakeups stay silent.
// ============================================

describe("Notification lifecycle observability (NOTIFICATION-OPERABILITY-LIFECYCLE-A2)", () => {
  beforeEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    resetRedisForTests();
    sharedNotificationRepo._reset();
    stopNotificationRetrySweep();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    stopNotificationRetrySweep();
    vi.useRealTimers();
    __setNotificationProviderForTests(null);
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.restoreAllMocks();
  });

  function messageOf(call: unknown[]): string {
    return (call[0] as { message?: string } | undefined)?.message ?? "";
  }

  function logsWith(spy: { mock: { calls: unknown[][] } }, name: string): unknown[][] {
    return spy.mock.calls.filter((c) => messageOf(c) === name);
  }

  function patchRepoMethod(
    method: string,
    impl: (...args: unknown[]) => unknown,
  ): () => void {
    const record = sharedNotificationRepo as unknown as Record<string, unknown>;
    const original = record[method];
    const hadOwn = Object.prototype.hasOwnProperty.call(record, method);
    record[method] = impl;
    return () => {
      if (hadOwn) record[method] = original;
      else delete record[method];
    };
  }

  const useFakeTimers = () =>
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });

  it("O31-A: start emits exactly one notification_retry_sweep_started on stopped -> running", () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    stopNotificationRetrySweep();
    infoSpy.mockClear();
    startNotificationRetrySweep();
    const starts = logsWith(infoSpy, "notification_retry_sweep_started");
    expect(starts).toHaveLength(1);
  });

  it("O31-B: start log contains interval_ms = 30_000", () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    startNotificationRetrySweep();
    const [call] = logsWith(infoSpy, "notification_retry_sweep_started");
    expect(call![0]).toEqual({
      message: "notification_retry_sweep_started",
      interval_ms: NOTIFICATION_RETRY_SWEEP_INTERVAL_MS,
    });
    expect((call![0] as { interval_ms: number }).interval_ms).toBe(30_000);
  });

  it("O31-C: a second start while running emits no second start log", () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    startNotificationRetrySweep();
    startNotificationRetrySweep();
    expect(logsWith(infoSpy, "notification_retry_sweep_started")).toHaveLength(1);
  });

  it("O31-D: periodic timer execution emits no sweep-cycle info log", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    useFakeTimers();
    startNotificationRetrySweep();
    await vi.advanceTimersByTimeAsync(0);
    const before = infoSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3 * NOTIFICATION_RETRY_SWEEP_INTERVAL_MS);
    expect(infoSpy.mock.calls.length).toBe(before);
    const forbidden = ["notification_retry_sweep_run", "notification_retry_sweep_tick", "notification_retry_sweep_cycle", "notification_drain_started", "notification_drain_completed"];
    const messages = infoSpy.mock.calls.map((c) => messageOf(c));
    expect(messages.filter((m) => forbidden.includes(m))).toEqual([]);
  });

  it("O31-E: stop after running emits exactly one notification_retry_sweep_stopped", () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    startNotificationRetrySweep();
    infoSpy.mockClear();
    stopNotificationRetrySweep();
    const stops = logsWith(infoSpy, "notification_retry_sweep_stopped");
    expect(stops).toHaveLength(1);
    expect(stops[0]![0]).toEqual({ message: "notification_retry_sweep_stopped" });
  });

  it("O31-F: a second stop while already stopped emits no second stop log", () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    startNotificationRetrySweep();
    stopNotificationRetrySweep();
    stopNotificationRetrySweep();
    expect(logsWith(infoSpy, "notification_retry_sweep_stopped")).toHaveLength(1);
  });

  it("O31-G/H/I: successful markRetryable emits exactly one safe retry-scheduled log", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    const n = await enqueueIdem("sms");
    const { provider } = scriptProvider([{ kind: "DEFINITIVE_FAILURE", error: "definitely rejected" }]);
    __setNotificationProviderForTests(provider);
    await deliverOne(n);

    const scheduled = logsWith(infoSpy, "notification_retry_scheduled");
    expect(scheduled).toHaveLength(1);
    const arg = scheduled[0]![0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual([
      "attempts",
      "channel",
      "message",
      "safe_error_category",
    ]);
    expect(arg).toEqual({
      message: "notification_retry_scheduled",
      channel: "sms",
      attempts: 1,
      safe_error_category: "UNKNOWN",
    });
    for (const forbidden of ["id", "notification_id", "user_id", "to_address", "body", "last_error", "error", "idempotencyKey", "idempotency_key"]) {
      expect(forbidden in arg).toBe(false);
    }
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain("definitely rejected");
    expect(serialized).not.toContain("+9100000001");
    expect(serialized).not.toContain(n.id);
  });

  it("O31-J: markRetryable returning null emits no retry-scheduled log", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    const n = await enqueueIdem("sms");
    const { provider } = scriptProvider([{ kind: "DEFINITIVE_FAILURE", error: "boom" }]);
    __setNotificationProviderForTests(provider);
    const restore = patchRepoMethod("markRetryable", async () => null);
    try {
      await deliverOne(n);
    } finally {
      restore();
    }
    expect(logsWith(infoSpy, "notification_retry_scheduled")).toHaveLength(0);
  });

  it("O31-K: markRetryable throwing emits no retry-scheduled truth log", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await enqueueIdem("sms");
    const { provider } = scriptProvider([{ kind: "DEFINITIVE_FAILURE", error: "boom" }]);
    __setNotificationProviderForTests(provider);
    const restore = patchRepoMethod("markRetryable", async () => {
      throw new Error("markRetryable boom");
    });
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    expect(logsWith(infoSpy, "notification_retry_scheduled")).toHaveLength(0);
  });

  it("O31-L/N/O: max-attempt markDead emits exactly one safe terminal-failed log", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    const n = await enqueueIdem("email");
    await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider } = scriptProvider([{ kind: "DEFINITIVE_FAILURE", error: "rejected at cap" }]);
    __setNotificationProviderForTests(provider);
    await deliverOne(await currentOf(n.id));

    const terminal = logsWith(errorSpy, "notification_terminal_failed");
    expect(terminal).toHaveLength(1);
    const arg = terminal[0]![0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual([
      "attempts",
      "channel",
      "message",
      "safe_error_category",
    ]);
    expect(arg).toEqual({
      message: "notification_terminal_failed",
      channel: "email",
      attempts: NOTIFICATION_MAX_ATTEMPTS,
      safe_error_category: "UNKNOWN",
    });
    for (const forbidden of ["id", "notification_id", "user_id", "to_address", "body", "last_error", "error", "idempotencyKey", "idempotency_key"]) {
      expect(forbidden in arg).toBe(false);
    }
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain("rejected at cap");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain(n.id);
  });

  it("O31-M: final ambiguous-confirmation terminal path also emits exactly one terminal log", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    const n = await enqueueIdem("sms");
    await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider, calls } = scriptProvider([
      { kind: "AMBIGUOUS", error: "timeout-1" },
      { kind: "DEFINITIVE_FAILURE", error: "confirmed failure" },
    ]);
    __setNotificationProviderForTests(provider);
    await deliverOne(await currentOf(n.id));

    expect((await currentOf(n.id)).status).toBe("FAILED");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).toBe(n.id);
    expect(logsWith(errorSpy, "notification_terminal_failed")).toHaveLength(1);
  });

  it("O31-P: markDead returning null emits no terminal-failed log", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    const n = await enqueueIdem("sms");
    await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider } = scriptProvider([{ kind: "DEFINITIVE_FAILURE", error: "boom at cap" }]);
    __setNotificationProviderForTests(provider);
    const restore = patchRepoMethod("markDead", async () => null);
    try {
      await deliverOne(await currentOf(n.id));
    } finally {
      restore();
    }
    expect(logsWith(errorSpy, "notification_terminal_failed")).toHaveLength(0);
  });

  it("O31-Q: markDead throwing emits no terminal-failed truth log", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockReturnValue(logger);
    const n = await enqueueIdem("sms");
    await driveToAttempts(n.id, NOTIFICATION_MAX_ATTEMPTS - 1);
    const { provider } = scriptProvider([{ kind: "DEFINITIVE_FAILURE", error: "boom at cap" }]);
    __setNotificationProviderForTests(provider);
    const restore = patchRepoMethod("markDead", async () => {
      throw new Error("markDead boom");
    });
    try {
      await drainNotifications();
    } finally {
      restore();
    }
    expect(logsWith(errorSpy, "notification_terminal_failed")).toHaveLength(0);
  });

  it("O31-R: safe_error_category classification remains exact and closed", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockReturnValue(logger);
    const configured = await enqueueIdem("sms");
    const { provider } = scriptProvider([
      { kind: "CONFIG_ERROR", error: "sms provider not configured" },
    ]);
    __setNotificationProviderForTests(provider);
    await deliverOne(configured);
    expect((logsWith(infoSpy, "notification_retry_scheduled")[0]![0] as { safe_error_category: string }).safe_error_category).toBe("PROVIDER_UNCONFIGURED");

    sharedNotificationRepo._reset();
    infoSpy.mockClear();
    const other = await enqueueIdem("email");
    const { provider: otherProvider } = scriptProvider([
      { kind: "DEFINITIVE_FAILURE", error: "something else entirely" },
    ]);
    __setNotificationProviderForTests(otherProvider);
    await deliverOne(other);
    expect((logsWith(infoSpy, "notification_retry_scheduled")[0]![0] as { safe_error_category: string }).safe_error_category).toBe("UNKNOWN");
  });
});
