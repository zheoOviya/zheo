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
} from "./notifications";
import { sharedNotificationRepo } from "../repositories/shared";
import type { NotificationStatus } from "../repositories/notificationRepository";
import { MemoryNotificationRepository } from "../repositories/notificationRepository";

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
      await expect(sendSmsMessage("+9100000001", "hello")).resolves.toBe(true);
    });
  });

  it("T2: test-mode email fake path may succeed", async () => {
    await withNodeEnv("test", async () => {
      await expect(sendEmailMessage("owner@example.com", "hello")).resolves.toBe(true);
    });
  });

  it("T3: production-like SMS with no provider does not return success", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await withNodeEnv("production", async () => {
      await expect(sendSmsMessage("+9100000001", "hello")).rejects.toThrow(
        /provider not configured/,
      );
    });
  });

  it("T4: production-like email with no provider does not return success", async () => {
    vi.spyOn(logger, "error").mockReturnValue(logger);
    await withNodeEnv("production", async () => {
      await expect(sendEmailMessage("owner@example.com", "hello")).rejects.toThrow(
        /provider not configured/,
      );
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
