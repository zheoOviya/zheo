import { describe, expect, it, beforeEach, vi } from "vitest";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { runGiftExpirySweep } from "./giftExpirySweep";
import { razorpayService } from "./razorpay";
import type { GiftDTO } from "../repositories/giftRepository";

function seedGift(repo: MemoryGiftRepository, daysFromNow: number, status: GiftDTO["status"]): Promise<GiftDTO> {
  const expires = new Date(Date.now() + daysFromNow * 24 * 3600_000).toISOString();
  return repo.create({
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
  }).then(async (g) => {
    const updated = await repo.updateStatus(g.id, status);
    return updated!;
  });
}

describe("runGiftExpirySweep", () => {
  let giftRepo: MemoryGiftRepository;
  let paymentRepo: MemoryPaymentRepository;

  beforeEach(() => {
    giftRepo = new MemoryGiftRepository();
    paymentRepo = new MemoryPaymentRepository();
  });

  it("expires ACTIVE gifts past their expiry date", async () => {
    const gift = await seedGift(giftRepo, -1, "ACTIVE");
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(1);
    expect((await giftRepo.getById(gift.id))?.status).toBe("EXPIRED");
  });

  it("refunds an expired captured gift to REFUNDED in mock mode", async () => {
    const gift = await seedGift(giftRepo, -1, "ACTIVE");
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_mock_paid",
      amount: 30,
    });
    // A captured payment carries a razorpay_payment_id; the sweep only refunds
    // payments that were actually captured (matches production semantics).
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_mock_paid",
      status: "CAPTURED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: null,
    });
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
    const gift = await seedGift(giftRepo, -1, "ACTIVE");
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_mock_paid",
      amount: 30,
    });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_mock_paid",
      status: "CAPTURED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: null,
    });

    const first = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(first.refunded).toBe(1);
    expect((await giftRepo.getById(gift.id))?.status).toBe("REFUNDED");

    const second = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(second.refunded).toBe(0);
    expect(second.expired).toBe(0);
  });

  it("skips a gift whose refund was already submitted (refund_requested_at set)", async () => {
    const gift = await seedGift(giftRepo, -1, "ACTIVE");
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_mock_paid",
      amount: 30,
    });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_mock_paid",
      status: "CAPTURED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: null,
    });

    // Simulate a submission that is in-flight awaiting the (mock-less)
    // refund webhook: the marker is set but nothing has resolved yet.
    const submitted = await giftRepo.markRefundSubmitted(gift.id);
    expect(submitted).not.toBeNull();
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.refunded).toBe(0);
    expect((await giftRepo.getById(gift.id))?.status).toBe("REFUNDING");
  });

  it("does not refund an expired gift whose payment was never captured", async () => {
    const gift = await seedGift(giftRepo, -1, "ACTIVE");
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
    const gift = await seedGift(giftRepo, -1, "ACTIVE");
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

  it("never expires or refunds a gift that is already bound to an order", async () => {
    const gift = await seedGift(giftRepo, -1, "ACTIVE");
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_mock_bound",
      amount: 30,
    });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_mock_bound",
      status: "CAPTURED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: null,
    });
    await giftRepo.markClaimed(gift.id, "user-recipient");
    await giftRepo.bindToOrder(gift.id, "order-in-flight");
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(0);
    expect(result.refunded).toBe(0);
    // In-flight (claimed + bound) gifts are never expired or refunded.
    expect((await giftRepo.getById(gift.id))?.status).toBe("CLAIMED");
    expect((await giftRepo.getById(gift.id))?.redeemed_order_id).toBe("order-in-flight");
  });

  it("leaves unexpired gifts alone", async () => {
    const gift = await seedGift(giftRepo, 10, "ACTIVE");
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(0);
    expect((await giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
  });
});
