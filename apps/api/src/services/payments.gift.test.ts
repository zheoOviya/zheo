import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { PaymentService } from "./payments";
import { razorpayService } from "./razorpay";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function seedGift(giftRepo: MemoryGiftRepository, tag: string, price = 30) {
  return giftRepo.create({
    sender_id: USER_ID,
    restaurant_id: "22222222-2222-4222-8222-222222222222",
    menu_item_id: "33333333-3333-4333-8333-333333333333",
    item_snapshot: {
      name: "Samosa",
      price,
      image_url: null,
      dietary_tags: { VEG: true },
      spice_level: 2,
      customizations: [],
    },
    price_paid: price,
    message: null,
    recipient_name: null,
    claim_token: `tok-${tag}`,
    claim_code: `ABC${tag.slice(0, 4).toUpperCase()}9`,
    expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
  });
}

describe("PaymentService gift path (Model A)", () => {
  let paymentRepo: MemoryPaymentRepository;
  let orderRepo: MemoryOrderRepository;
  let giftRepo: MemoryGiftRepository;
  let service: PaymentService;

  beforeEach(() => {
    paymentRepo = new MemoryPaymentRepository();
    orderRepo = new MemoryOrderRepository();
    giftRepo = new MemoryGiftRepository();
    service = new PaymentService(paymentRepo, orderRepo, giftRepo);
    razorpayService._resetTestState();
  });

  afterEach(() => {
    razorpayService._resetTestState();
  });

  it("creates a gift payment and activates the gift on captured webhook", async () => {
    const gift = await seedGift(giftRepo, "1");

    const result = await service.createGiftPayment(gift.id, USER_ID);
    expect(result.payment_state).toBe("READY");
    expect(result.razorpay_order_id).toMatch(/^order_mock_/);
    expect(result.amount).toBe(30);

    const payment = await paymentRepo.getByGiftId(gift.id);
    expect(payment).not.toBeNull();
    expect(payment?.razorpay_order_id).toBe(result.razorpay_order_id);

    const webhook = razorpayService.buildMockWebhook(
      result.razorpay_order_id!,
      3000,
      "payment.captured",
    );
    const processed = await service.processWebhook(webhook.rawBody, webhook.signature);
    expect(processed.giftStatus).toBe("ACTIVE");

    const after = await giftRepo.getById(gift.id);
    expect(after?.status).toBe("ACTIVE");
  });

  it("leaves the gift PENDING on a failed payment webhook", async () => {
    const gift = await seedGift(giftRepo, "2");

    const result = await service.createGiftPayment(gift.id, USER_ID);
    const webhook = razorpayService.buildMockWebhook(
      result.razorpay_order_id!,
      3000,
      "payment.failed",
    );
    const processed = await service.processWebhook(webhook.rawBody, webhook.signature);
    expect(processed.giftStatus).toBe("PENDING");
    expect((await giftRepo.getById(gift.id))?.status).toBe("PENDING");
  });

  it("returns the same Razorpay order on retry before the payment settles (Model A: no duplicate order)", async () => {
    const gift = await seedGift(giftRepo, "3");

    const first = await service.createGiftPayment(gift.id, USER_ID);
    const retry = await service.createGiftPayment(gift.id, USER_ID);
    expect(retry.razorpay_order_id).toBe(first.razorpay_order_id);
    expect(retry.payment_id).toBe(first.payment_id);
    // Model A: exactly one provider order is ever minted for the gift.
    expect(razorpayService.createOrderCount).toBe(1);

    const webhook = razorpayService.buildMockWebhook(
      retry.razorpay_order_id!,
      3000,
      "payment.captured",
    );
    await service.processWebhook(webhook.rawBody, webhook.signature);

    const payment = await paymentRepo.getByGiftId(gift.id);
    expect(payment?.razorpay_order_id).toBe(retry.razorpay_order_id);
    expect(payment?.razorpay_payment_id).not.toBeNull();
  });

  it("REUSES the same provider order after a FAILED payment attempt (Model A primary regression)", async () => {
    const gift = await seedGift(giftRepo, "fail");

    const first = await service.createGiftPayment(gift.id, USER_ID);
    const failed = razorpayService.buildMockWebhook(first.razorpay_order_id!, 3000, "payment.failed");
    await service.processWebhook(failed.rawBody, failed.signature);

    // A failed customer payment attempt NEVER mints a new Razorpay order.
    const retry = await service.createGiftPayment(gift.id, USER_ID);
    expect(retry.razorpay_order_id).toBe(first.razorpay_order_id);
    expect(retry.payment_id).toBe(first.payment_id);
    expect(razorpayService.createOrderCount).toBe(1);

    const captured = razorpayService.buildMockWebhook(retry.razorpay_order_id!, 3000, "payment.captured");
    const processed = await service.processWebhook(captured.rawBody, captured.signature);
    expect(processed.giftStatus).toBe("ACTIVE");
    expect((await giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
  });

  it("rejects creating a payment for a gift that was already captured", async () => {
    const gift = await seedGift(giftRepo, "4");

    const result = await service.createGiftPayment(gift.id, USER_ID);
    const captured = razorpayService.buildMockWebhook(result.razorpay_order_id!, 3000, "payment.captured");
    await service.processWebhook(captured.rawBody, captured.signature);

    await expect(service.createGiftPayment(gift.id, USER_ID)).rejects.toMatchObject({
      code: "GIFT_ALREADY_PAID",
    });
    expect((await giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
  });

  it("marks a gift REFUNDED on a refund webhook", async () => {
    const gift = await seedGift(giftRepo, "ref");

    const result = await service.createGiftPayment(gift.id, USER_ID);
    const captured = razorpayService.buildMockWebhook(result.razorpay_order_id!, 3000, "payment.captured");
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

  it("forbids a non-sender from creating the gift payment (Task 3G)", async () => {
    const gift = await seedGift(giftRepo, "3g");
    await expect(
      service.createGiftPayment(gift.id, "99999999-9999-4999-8999-999999999999"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await paymentRepo.getByGiftId(gift.id))).toBeNull();
  });

  it("returns 202 IN_PROGRESS when another instance holds the initiation lease", async () => {
    const gift = await seedGift(giftRepo, "lease");
    // Seed an in-flight intent owned by a DIFFERENT instance with an active lease.
    await paymentRepo.createReservation({
      gift_id: gift.id,
      amount: 30,
      receipt: "pay_seed_lease",
      lease_owner: "instance-A",
      leaseTtlMs: 60_000,
    });

    const res = await service.createGiftPayment(gift.id, USER_ID);
    expect(res.payment_state).toBe("IN_PROGRESS");
    expect(res.razorpay_order_id).toBeUndefined();
    expect(res.retryable).toBe(true);
    // No provider order was minted while the lease is held.
    expect(razorpayService.createOrderCount).toBe(0);
  });

  it("takes over an expired-lease intent with the SAME receipt (never a new provider order)", async () => {
    const gift = await seedGift(giftRepo, "takeover");
    // Crash simulation: intent reserved with an expired lease, gateway order
    // never created. Another instance must take over and mint exactly one order.
    await paymentRepo.createReservation({
      gift_id: gift.id,
      amount: 30,
      receipt: "pay_seed_takeover",
      lease_owner: "instance-A",
      leaseTtlMs: -1000,
    });

    const res = await service.createGiftPayment(gift.id, USER_ID);
    expect(res.payment_state).toBe("READY");
    expect(res.razorpay_order_id).toMatch(/^order_mock_/);
    expect(razorpayService.createOrderCount).toBe(1);

    // A further retry reuses the intent's stored receipt/order; still 1 order.
    const again = await service.createGiftPayment(gift.id, USER_ID);
    expect(again.razorpay_order_id).toBe(res.razorpay_order_id);
    expect(razorpayService.createOrderCount).toBe(1);
  });

  it("reconciles an ambiguous provider state by exact receipt (reuses, never re-creates)", async () => {
    const gift = await seedGift(giftRepo, "ambig");
    // Simulate a crash AFTER the provider order was created but BEFORE the DB
    // finalize: the provider registry already has an order for the receipt.
    const preExisting = await razorpayService.createOrder(3000, "pay_seed_ambig");
    await paymentRepo.createReservation({
      gift_id: gift.id,
      amount: 30,
      receipt: "pay_seed_ambig",
      lease_owner: "instance-A",
      leaseTtlMs: -1000,
    });

    const res = await service.createGiftPayment(gift.id, USER_ID);
    expect(res.payment_state).toBe("READY");
    // The SAME provider order is reused — no second order was minted.
    expect(res.razorpay_order_id).toBe(preExisting.id);
    expect(razorpayService.createOrderCount).toBe(1);
  });

  it("marks the intent FAILED_INITIATION when the gateway rejects order creation", async () => {
    const gift = await seedGift(giftRepo, "gwfail");
    razorpayService._simulateCreateOrderError(new Error("gateway down"));

    await expect(service.createGiftPayment(gift.id, USER_ID)).rejects.toThrow("gateway down");
    const payment = await paymentRepo.getByGiftId(gift.id);
    expect(payment?.status).toBe("FAILED_INITIATION");
    expect(payment?.razorpay_order_id).toBeNull();
    expect(payment?.attempts.some((a) => a.event === "initiation_failed")).toBe(true);
    expect(payment?.attempts.some((a) => a.event === "provider_order_created")).toBe(false);

    // Clear the gateway and retry: the SAME intent row recovers (FAILED_INITIATION
    // is retryable via lease acquisition), no second row, no second receipt.
    razorpayService._simulateCreateOrderError(null);
    const retry = await service.createGiftPayment(gift.id, USER_ID);
    expect(retry.payment_state).toBe("READY");
    expect(retry.payment_id).toBe(payment!.id);
    expect(razorpayService.createOrderCount).toBe(1);
    expect((await paymentRepo.getByGiftId(gift.id))?.status).toBe("CREATED");
  });

  it("never downgrades a captured payment on a late payment.failed webhook (monotonic)", async () => {
    const gift = await seedGift(giftRepo, "mono");

    const result = await service.createGiftPayment(gift.id, USER_ID);
    const captured = razorpayService.buildMockWebhook(result.razorpay_order_id!, 3000, "payment.captured");
    const processed = await service.processWebhook(captured.rawBody, captured.signature);
    expect(processed.giftStatus).toBe("ACTIVE");

    // A LATER failed webhook (fresh payment id, out-of-order delivery) must not
    // regress the intent or the gift.
    const lateFailed = razorpayService.buildMockWebhook(result.razorpay_order_id!, 3000, "payment.failed");
    const late = await service.processWebhook(lateFailed.rawBody, lateFailed.signature);
    expect(late.idempotent).toBe(true);

    const payment = await paymentRepo.getByGiftId(gift.id);
    expect(payment?.status).toBe("CAPTURED");
    expect((await giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
  });
});
