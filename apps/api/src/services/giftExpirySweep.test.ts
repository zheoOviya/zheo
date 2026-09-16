import { describe, expect, it, beforeEach, vi } from "vitest";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { runGiftExpirySweep } from "./giftExpirySweep";
import { razorpayService } from "./razorpay";
import * as eventBus from "../lib/eventBus";
import type { GiftDTO } from "../repositories/giftRepository";

const PAST = -1;

async function seedGift(
  repo: MemoryGiftRepository,
  daysFromNow: number,
  status: GiftDTO["status"],
): Promise<GiftDTO> {
  const expires = new Date(Date.now() + daysFromNow * 24 * 3600_000).toISOString();
  const gift = await repo.create({
    sender_id: "11111111-1111-4111-8111-111111111111",
    restaurant_id: "22222222-2222-4222-8222-222222222222",
    menu_item_id: "33333333-3333-4333-8333-333333333333",
    item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
    price_paid: 30,
    message: null,
    recipient_name: null,
    claim_token: `tok-${Math.random()}`,
    claim_code: "ABCD1234",
    expires_at: expires,
  });
  if (status === "PENDING") return gift;
  const paid = await repo.markPaid(gift.id);
  if (!paid) throw new Error("seedGift: failed to activate");
  if (status === "ACTIVE") return paid;
  if (status === "CLAIMED") {
    const claimed = await repo.markClaimed(gift.id, "user-recipient");
    if (!claimed) throw new Error("seedGift: failed to claim");
    return claimed;
  }
  throw new Error(`seedGift: unsupported status ${status}`);
}

async function capturePayment(
  paymentRepo: MemoryPaymentRepository,
  giftId: string,
  orderId: string,
): Promise<void> {
  const payment = await paymentRepo.create({
    gift_id: giftId,
    razorpay_order_id: orderId,
    amount: 30,
  });
  await paymentRepo.updateWebhookResult(payment.id, {
    razorpay_payment_id: `pay_${orderId}`,
    status: "CAPTURED",
    method: "upi",
    webhook_event: "payment.captured",
    webhook_raw: null,
  });
}

describe("runGiftExpirySweep", () => {
  let giftRepo: MemoryGiftRepository;
  let paymentRepo: MemoryPaymentRepository;

  beforeEach(() => {
    giftRepo = new MemoryGiftRepository();
    paymentRepo = new MemoryPaymentRepository();
    vi.restoreAllMocks();
  });

  it("expires ACTIVE gifts past their expiry date", async () => {
    const gift = await seedGift(giftRepo, PAST, "ACTIVE");
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(1);
    expect((await giftRepo.getById(gift.id))?.status).toBe("EXPIRED");
  });

  it("refunds an expired captured gift to REFUNDED in mock mode", async () => {
    const gift = await seedGift(giftRepo, PAST, "ACTIVE");
    // A captured payment carries a razorpay_payment_id; the sweep only refunds
    // payments that were actually captured (matches production semantics).
    await capturePayment(paymentRepo, gift.id, "order_mock_paid");
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.refunded).toBe(1);
    const after = await giftRepo.getById(gift.id);
    // No refund webhook exists in mock/test mode, so the submission resolves
    // immediately instead of lingering in REFUNDING forever.
    expect(after?.status).toBe("REFUNDED");
    expect(after?.refunded_at).not.toBeNull();
    expect(after?.refund_requested_at).not.toBeNull();
  });

  it("never refunds the same gift twice across sweeps", async () => {
    const gift = await seedGift(giftRepo, PAST, "ACTIVE");
    await capturePayment(paymentRepo, gift.id, "order_mock_paid");

    const first = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(first.refunded).toBe(1);
    expect((await giftRepo.getById(gift.id))?.status).toBe("REFUNDED");

    const second = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(second.refunded).toBe(0);
    expect(second.expired).toBe(0);
  });

  it("skips a gift whose refund was already submitted (refund_requested_at set)", async () => {
    const gift = await seedGift(giftRepo, PAST, "ACTIVE");
    await capturePayment(paymentRepo, gift.id, "order_mock_paid");

    // Simulate a submission that is in-flight awaiting the (mock-less)
    // refund webhook: the marker is set but nothing has resolved yet.
    const submitted = await giftRepo.markRefundSubmitted(gift.id, ["ACTIVE"]);
    expect(submitted).not.toBeNull();
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.refunded).toBe(0);
    expect((await giftRepo.getById(gift.id))?.status).toBe("REFUNDING");
  });

  it("does not refund an expired gift whose payment was never captured", async () => {
    const gift = await seedGift(giftRepo, PAST, "ACTIVE");
    await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_mock_unpaid",
      amount: 30,
    });
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(1);
    expect(result.refunded).toBe(0);
    // The gift expires; without a captured payment there is nothing to refund.
    expect((await giftRepo.getById(gift.id))?.status).toBe("EXPIRED");
  });

  it("never refunds an expired gift whose payment FAILED (never charged)", async () => {
    const gift = await seedGift(giftRepo, PAST, "ACTIVE");
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_mock_failed",
      amount: 30,
    });
    // A FAILED payment still carries a razorpay_payment_id but no money ever
    // moved; refunding it would invent a refund.
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_mock_failed",
      status: "FAILED",
      method: "upi",
      webhook_event: "payment.failed",
      webhook_raw: null,
    });
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(1);
    expect(result.refunded).toBe(0);
    expect((await giftRepo.getById(gift.id))?.status).toBe("EXPIRED");
  });

  // ============================================================
  // T7/T8/T9 — a gift bound after the sweep's read must survive
  // ============================================================
  it("T7/T8/T9: never expires or refunds a gift that is bound to an order, and emits nothing", async () => {
    const gift = await seedGift(giftRepo, PAST, "CLAIMED");
    await capturePayment(paymentRepo, gift.id, "order_mock_bound");
    await giftRepo.bindToOrder(gift.id, "order-in-flight");

    const emitSpy = vi.spyOn(eventBus, "emit").mockResolvedValue(undefined);
    const refundSpy = vi
      .spyOn(razorpayService, "refund")
      .mockResolvedValue({ id: "rfnd_test", status: "processed" });

    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    // A bound gift is not a valid expiry target: the CAS loses, so the counter
    // does not inflate and no refund is attempted from the stale DTO.
    expect(result.expired).toBe(0);
    expect(result.refunded).toBe(0);
    expect((await giftRepo.getById(gift.id))?.status).toBe("CLAIMED");
    expect((await giftRepo.getById(gift.id))?.redeemed_order_id).toBe("order-in-flight");
    // T8: no GiftExpired on a CAS miss.
    expect(emitSpy).not.toHaveBeenCalled();
    // T9: no gateway refund submission on a CAS miss.
    expect(refundSpy).not.toHaveBeenCalled();
  });

  it("emits GiftExpired exactly once for a successful expiry", async () => {
    await seedGift(giftRepo, PAST, "ACTIVE");
    const emitSpy = vi.spyOn(eventBus, "emit").mockResolvedValue(undefined);
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(1);
    const expiryEvents = emitSpy.mock.calls.filter((c) => c[0]?.event_name === "GiftExpired");
    expect(expiryEvents).toHaveLength(1);
  });

  it("leaves unexpired gifts alone", async () => {
    const gift = await seedGift(giftRepo, 10, "ACTIVE");
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(0);
    expect((await giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
  });
});
