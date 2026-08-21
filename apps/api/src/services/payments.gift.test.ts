import { describe, expect, it, beforeEach } from "vitest";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { PaymentService } from "./payments";
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

    const payment = await paymentRepo.getByGiftId(gift.id);
    const refundWebhook = razorpayService.buildMockRefundWebhook(
      payment!.razorpay_payment_id!,
      3000,
    );
    const processed = await service.processWebhook(refundWebhook.rawBody, refundWebhook.signature);
    expect(processed.giftStatus).toBe("REFUNDED");
    expect((await giftRepo.getById(gift.id))?.status).toBe("REFUNDED");
  });
});
