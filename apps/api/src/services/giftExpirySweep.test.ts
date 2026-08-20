import { describe, expect, it, beforeEach } from "vitest";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { runGiftExpirySweep } from "./giftExpirySweep";
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

  it("moves an expired paid gift to REFUNDING and requests a refund", async () => {
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
    expect(after?.status).toBe("REFUNDING");
  });

  it("leaves unexpired gifts alone", async () => {
    const gift = await seedGift(giftRepo, 10, "ACTIVE");
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(0);
    expect((await giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
  });
});
