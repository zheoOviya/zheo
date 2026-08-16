import { beforeEach, describe, expect, it } from "vitest";
import { emit, createEventEnvelope } from "../lib/eventBus";
import { resetRedisForTests } from "../lib/redis";
import { registerVendorNotificationHandlers, drainNotifications } from "./notifications";
import { sharedNotificationRepo } from "../repositories/shared";
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

  it("retryable failure stays PENDING until backoff elapses, then becomes dead", async () => {
    const n = await repo.enqueue({
      user_id: APPLICANT_ID,
      channel: "sms",
      to_address: "+91",
      body: "hi",
    });

    await repo.markRetryable(n.id, "boom", new Date(Date.now() + 60_000));
    expect(await repo.listPending()).toHaveLength(0);

    await repo.markRetryable(n.id, "boom", new Date(Date.now() - 1_000));
    expect(await repo.listPending()).toHaveLength(1);

    await repo.markDead(n.id, "boom");
    const all = await repo.listAll();
    expect(all[0]!.status).toBe("FAILED");
    expect(all[0]!.attempts).toBe(3);
    expect(await repo.listPending()).toHaveLength(0);
  });
});
