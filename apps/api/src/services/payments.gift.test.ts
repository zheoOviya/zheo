import { describe, expect, it, beforeEach, vi } from "vitest";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { PaymentService } from "./payments";
import { submitGiftRefund } from "./gift";
import { razorpayService } from "./razorpay";

describe("PaymentService gift path", () => {
  let paymentRepo: MemoryPaymentRepository;
  let orderRepo: MemoryOrderRepository;
  let giftRepo: MemoryGiftRepository;
  let service: PaymentService;

  beforeEach(() => {
    paymentRepo = new MemoryPaymentRepository();
    orderRepo = new MemoryOrderRepository();
    giftRepo = new MemoryGiftRepository();
    service = new PaymentService(paymentRepo, orderRepo, giftRepo);
    paymentRepo._reset();
    orderRepo._reset();
    giftRepo._reset();
  });

  it("creates a gift payment and activates the gift on captured webhook", async () => {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: {
        name: "Samosa",
        price: 30,
        image_url: null,
        dietary_tags: { VEG: true },
        spice_level: 2,
        customizations: [],
      },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: "tok-1",
      claim_code: "ABC12345",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });

    const result = await service.createGiftPayment(gift.id);
    expect(result.razorpay_order_id).toMatch(/^order_mock_/);
    expect(result.amount).toBe(30);

    const payment = await paymentRepo.getByGiftId(gift.id);
    expect(payment).not.toBeNull();

    const webhook = razorpayService.buildMockWebhook(
      result.razorpay_order_id,
      3000,
      "payment.captured",
    );
    const processed = await service.processWebhook(webhook.rawBody, webhook.signature);
    expect(processed.giftStatus).toBe("ACTIVE");

    const after = await giftRepo.getById(gift.id);
    expect(after?.status).toBe("ACTIVE");
  });

  it("leaves the gift PENDING on a failed payment webhook", async () => {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: "tok-2",
      claim_code: "ABC12346",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });

    const result = await service.createGiftPayment(gift.id);
    const webhook = razorpayService.buildMockWebhook(
      result.razorpay_order_id,
      3000,
      "payment.failed",
    );
    const processed = await service.processWebhook(webhook.rawBody, webhook.signature);
    expect(processed.giftStatus).toBe("PENDING");
    expect((await giftRepo.getById(gift.id))?.status).toBe("PENDING");
  });

  it("returns the same Razorpay order on retry before the payment settles (idempotent)", async () => {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: "tok-3",
      claim_code: "ABC12347",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });

    // First attempt is left unpaid, then a retry must NOT mint a second
    // Razorpay order — re-presenting the same pending order is the point of
    // the "Pay & Send" retry (no double charge).
    const first = await service.createGiftPayment(gift.id);
    const retry = await service.createGiftPayment(gift.id);
    expect(retry.razorpay_order_id).toBe(first.razorpay_order_id);

    const webhook = razorpayService.buildMockWebhook(
      retry.razorpay_order_id,
      3000,
      "payment.captured",
    );
    await service.processWebhook(webhook.rawBody, webhook.signature);

    // Refund/cancel lookups must land on the (single) captured row.
    const payment = await paymentRepo.getByGiftId(gift.id);
    expect(payment).not.toBeNull();
    expect(payment?.razorpay_order_id).toBe(retry.razorpay_order_id);
    expect(payment?.razorpay_payment_id).not.toBeNull();
  });

  it("rejects creating a payment for a gift that was already captured", async () => {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: "tok-4",
      claim_code: "ABC12348",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });

    const result = await service.createGiftPayment(gift.id);
    const captured = razorpayService.buildMockWebhook(result.razorpay_order_id, 3000, "payment.captured");
    await service.processWebhook(captured.rawBody, captured.signature);

    await expect(service.createGiftPayment(gift.id)).rejects.toMatchObject({
      code: "GIFT_ALREADY_PAID",
    });
    expect((await giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
  });

  it("mints a fresh Razorpay order when the first payment attempt FAILED", async () => {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: "tok-fail",
      claim_code: "ABCFAIL7",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });

    // A FAILED Razorpay order is dead; re-presenting it would reject. The
    // retry therefore mints a brand-new order instead of reusing the old one.
    const first = await service.createGiftPayment(gift.id);
    const failed = razorpayService.buildMockWebhook(first.razorpay_order_id, 3000, "payment.failed");
    await service.processWebhook(failed.rawBody, failed.signature);

    const retry = await service.createGiftPayment(gift.id);
    expect(retry.razorpay_order_id).not.toBe(first.razorpay_order_id);

    const captured = razorpayService.buildMockWebhook(retry.razorpay_order_id, 3000, "payment.captured");
    const processed = await service.processWebhook(captured.rawBody, captured.signature);
    expect(processed.giftStatus).toBe("ACTIVE");
    expect((await giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
  });

  it("marks a gift REFUNDED on a refund webhook", async () => {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: "tok-3",
      claim_code: "ABC12347",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });

    const result = await service.createGiftPayment(gift.id);
    const captured = razorpayService.buildMockWebhook(result.razorpay_order_id, 3000, "payment.captured");
    await service.processWebhook(captured.rawBody, captured.signature);

    // A refund webhook can only arrive for a gift that already entered the
    // refund lifecycle (ACTIVE -> REFUNDING via a reserved submission). The
    // stale-confirmation guard deliberately rejects a webhook that would
    // regress a still-ACTIVE gift.
    const reserved = await giftRepo.markRefundSubmitted(gift.id, ["ACTIVE"]);
    expect(reserved?.status).toBe("REFUNDING");

    const payment = await paymentRepo.getByGiftId(gift.id);
    const refundWebhook = razorpayService.buildMockRefundWebhook(
      payment!.razorpay_payment_id!,
      3000,
    );
    const processed = await service.processWebhook(refundWebhook.rawBody, refundWebhook.signature);
    expect(processed.giftStatus).toBe("REFUNDED");
    expect((await giftRepo.getById(gift.id))?.status).toBe("REFUNDED");
  });

  // ============================================================
  // GIFT-3 / T10 — expected-state refund reservation
  // ============================================================
  async function seedActiveCapturedGift(claimToken: string): Promise<string> {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: claimToken,
      claim_code: "ABC12347",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });
    await giftRepo.markPaid(gift.id);
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: `order_${claimToken}`,
      amount: 30,
    });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: `pay_${claimToken}`,
      status: "CAPTURED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: null,
    });
    return gift.id;
  }

  it("T10: a claim that wins blocks an ACTIVE cancel reservation and the gateway call", async () => {
    const giftId = await seedActiveCapturedGift("tok-claim-win");
    // Capture the DTO as a stale sender-cancel would have read it (ACTIVE).
    const staleActive = (await giftRepo.getById(giftId))!;
    expect(staleActive.status).toBe("ACTIVE");

    // The claim wins after the cancel's read.
    const claimed = await giftRepo.markClaimed(giftId, "user-recipient");
    expect(claimed?.status).toBe("CLAIMED");

    const refundSpy = vi
      .spyOn(razorpayService, "refund")
      .mockResolvedValue({ id: "rfnd_test", status: "processed" });

    const result = await submitGiftRefund(staleActive, giftRepo, paymentRepo, ["ACTIVE"]);

    expect(result.status).toBe("CLAIMED");
    const after = await giftRepo.getById(giftId);
    expect(after?.status).toBe("CLAIMED");
    expect(after?.refund_requested_at).toBeNull();
    // If the expected-state CAS loses, no external refund is ever attempted.
    expect(refundSpy).not.toHaveBeenCalled();
  });

  it("reserves the refund before calling the gateway on a legitimate ACTIVE cancel", async () => {
    const giftId = await seedActiveCapturedGift("tok-reserve-order");
    const active = (await giftRepo.getById(giftId))!;

    const reserveSpy = vi.spyOn(giftRepo, "markRefundSubmitted");
    const refundSpy = vi
      .spyOn(razorpayService, "refund")
      .mockResolvedValue({ id: "rfnd_test", status: "processed" });

    const result = await submitGiftRefund(active, giftRepo, paymentRepo, ["ACTIVE"]);

    expect(result.status).toBe("REFUNDED");
    expect(reserveSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(reserveSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      refundSpy.mock.invocationCallOrder[0]!,
    );
  });
});
