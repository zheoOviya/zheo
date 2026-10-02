import { beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus } from "@snakzap/types";

// ============================================
// EVT-B2B-PAY-A — ordinary/local payment producer transactional outbox wiring.
//
// Proves the scoped producers (CashOnPickupSelected, GiftPaid,
// PaymentSucceeded, PaymentFailed, GiftRefunded) enqueue their events on the
// SAME commit boundary as the local business write and no longer direct-emit.
//
// MEMORY_MODE = NON_DURABLE_TEST_PARITY: the passthrough port has no rollback
// and no concurrency guarantee, so this file proves enqueue/CAS/failure control
// flow and the removal of the direct emit path. Real rollback atomicity is
// proven against PostgreSQL by realPgB2bPayAtomicity.ts.
// ============================================

import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { MemoryPaymentTransactionPort } from "../repositories/paymentAtomicityContracts";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";
import type { EventOutboxRow } from "../repositories/eventOutboxRepository";
import { PaymentService } from "./payments";
import { razorpayService } from "./razorpay";

const UID = "11111111-1111-4111-8111-111111111111";
const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM = "b0000000-0000-4000-8000-000000000001";

const rowsFor = (name: string): EventOutboxRow[] =>
  memoryEventOutbox._all().filter((r) => r.event_name === name);

describe("EVT-B2B-PAY-A payment producer transactional outbox", () => {
  let paymentRepo: MemoryPaymentRepository;
  let orderRepo: MemoryOrderRepository;
  let giftRepo: MemoryGiftRepository;
  let service: PaymentService;

  beforeEach(() => {
    memoryEventOutbox._reset();
    paymentRepo = new MemoryPaymentRepository();
    orderRepo = new MemoryOrderRepository();
    giftRepo = new MemoryGiftRepository();
    service = new PaymentService(paymentRepo, orderRepo, giftRepo);
  });

  function seedOrder(id: string, status: OrderStatus, total = 100): void {
    const now = new Date().toISOString();
    orderRepo._seed({
      id,
      user_id: UID,
      restaurant_id: REST_ID,
      items: [],
      total_amount: total,
      status,
      commission_rate: 0.08,
      commission_amount: 8,
      pickup_otp: null,
      checked_in: false,
      scheduled_pickup_time: null,
      created_at: now,
      updated_at: now,
    });
  }

  async function seedGift(price = 30): Promise<string> {
    const gift = await giftRepo.create({
      sender_id: UID,
      restaurant_id: REST_ID,
      menu_item_id: MENU_ITEM,
      item_snapshot: {
        name: "Gift Item",
        price,
        image_url: null,
        dietary_tags: {},
        spice_level: 1,
        customizations: [],
      },
      price_paid: price,
      message: null,
      recipient_name: null,
      claim_token: `tok-${Math.random().toString(36).slice(2)}`,
      claim_code: "GIFT1234",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });
    return gift.id;
  }

  // ---------------- P1: CashOnPickupSelected ----------------

  it("P1 cod: payment + order confirmation + CashOnPickupSelected enqueue together", async () => {
    const orderId = "c0000000-0000-4000-8000-000000000001";
    seedOrder(orderId, "DRAFT", 100);

    const res = await service.createPaymentOrder(orderId, "cod", UID);
    expect(res.payment_method).toBe("cod");
    expect((await orderRepo.getById(orderId))?.status).toBe("CONFIRMED");

    const rows = rowsFor("CashOnPickupSelected");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregate_id).toBe(orderId);
    const payment = await paymentRepo.getByOrderId(orderId);
    expect(payment).not.toBeNull();
    expect((rows[0]!.payload as { payment_id: string }).payment_id).toBe(payment?.id);
  });

  // ---------------- P3: PaymentSucceeded ----------------

  it("P3 capture: payment write + order CAS + PaymentSucceeded enqueue; duplicate is idempotent", async () => {
    const orderId = "c0000000-0000-4000-8000-000000000003";
    seedOrder(orderId, "PAYMENT_PENDING", 100);
    const rpOrderId = "order_mock_pay3";
    await paymentRepo.create({ order_id: orderId, razorpay_order_id: rpOrderId, amount: 100 });
    const mock = razorpayService.buildMockWebhook(rpOrderId, 10000, "payment.captured");

    const out = await service.processWebhook(mock.rawBody, mock.signature);
    expect(out).toMatchObject({ processed: true, idempotent: false, orderStatus: "CONFIRMED" });
    expect((await paymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("CAPTURED");

    const rows = rowsFor("PaymentSucceeded");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregate_id).toBe(orderId);

    const dup = await service.processWebhook(mock.rawBody, mock.signature);
    expect(dup).toMatchObject({ processed: false, idempotent: true });
    expect(rowsFor("PaymentSucceeded")).toHaveLength(1);
  });

  it("P3 capture CAS miss (order not PAYMENT_PENDING): no PaymentSucceeded", async () => {
    const orderId = "c0000000-0000-4000-8000-000000000004";
    seedOrder(orderId, "CANCELLED", 100);
    const rpOrderId = "order_mock_pay3_miss";
    await paymentRepo.create({ order_id: orderId, razorpay_order_id: rpOrderId, amount: 100 });
    const mock = razorpayService.buildMockWebhook(rpOrderId, 10000, "payment.captured");

    const out = await service.processWebhook(mock.rawBody, mock.signature);
    expect(out.processed).toBe(true);
    expect(out.orderStatus).toBe("CANCELLED");
    expect(rowsFor("PaymentSucceeded")).toHaveLength(0);
    expect((await paymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("CAPTURED");
  });

  // ---------------- P4: PaymentFailed ----------------

  it("P4 failure: payment write + order CAS + PaymentFailed enqueue", async () => {
    const orderId = "c0000000-0000-4000-8000-000000000005";
    seedOrder(orderId, "PAYMENT_PENDING", 100);
    const rpOrderId = "order_mock_pay4";
    await paymentRepo.create({ order_id: orderId, razorpay_order_id: rpOrderId, amount: 100 });
    const mock = razorpayService.buildMockWebhook(rpOrderId, 10000, "payment.failed", "declined");

    const out = await service.processWebhook(mock.rawBody, mock.signature);
    expect(out).toMatchObject({
      processed: true,
      idempotent: false,
      orderStatus: "PAYMENT_FAILED",
    });

    const rows = rowsFor("PaymentFailed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregate_id).toBe(orderId);
  });

  // ---------------- P2: GiftPaid ----------------

  it("P2 gift capture: payment write + gift CAS + GiftPaid enqueue", async () => {
    const giftId = await seedGift(30);
    const rpOrderId = "order_mock_gift2";
    await paymentRepo.create({ gift_id: giftId, razorpay_order_id: rpOrderId, amount: 30 });
    const mock = razorpayService.buildMockWebhook(rpOrderId, 3000, "payment.captured");

    const out = await service.processWebhook(mock.rawBody, mock.signature);
    expect(out.giftStatus).toBe("ACTIVE");
    expect((await giftRepo.getById(giftId))?.status).toBe("ACTIVE");

    const rows = rowsFor("GiftPaid");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregate_id).toBe(giftId);
  });

  it("P2 gift capture CAS miss (gift cancelled): no GiftPaid", async () => {
    const giftId = await seedGift(30);
    await giftRepo.cancelPending(giftId);
    const rpOrderId = "order_mock_gift2_miss";
    await paymentRepo.create({ gift_id: giftId, razorpay_order_id: rpOrderId, amount: 30 });
    const mock = razorpayService.buildMockWebhook(rpOrderId, 3000, "payment.captured");

    const out = await service.processWebhook(mock.rawBody, mock.signature);
    expect(out.processed).toBe(true);
    expect(out.giftStatus).toBe("PENDING");
    expect(rowsFor("GiftPaid")).toHaveLength(0);
    expect((await paymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("CAPTURED");
  });

  // ---------------- P5: GiftRefunded ----------------

  it("P5 gift refund: refund write + gift CAS + GiftRefunded enqueue", async () => {
    const giftId = await seedGift(30);
    const rpOrderId = "order_mock_gift5";
    await paymentRepo.create({ gift_id: giftId, razorpay_order_id: rpOrderId, amount: 30 });
    const captured = razorpayService.buildMockWebhook(rpOrderId, 3000, "payment.captured");
    await service.processWebhook(captured.rawBody, captured.signature);
    const paymentId = captured.payload.payload.payment.entity.id;
    // A gift refund confirmation only lands once the gift entered the refund
    // lifecycle (markRefunded CAS: REFUNDING/EXPIRED).
    await giftRepo.markRefunding(giftId, ["ACTIVE"]);

    const refund = razorpayService.buildMockRefundWebhook(paymentId, 3000);
    const out = await service.processWebhook(refund.rawBody, refund.signature);
    expect(out.giftStatus).toBe("REFUNDED");
    expect((await giftRepo.getById(giftId))?.status).toBe("REFUNDED");

    const rows = rowsFor("GiftRefunded");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregate_id).toBe(giftId);
  });

  // ---------------- enqueue failure is never swallowed ----------------

  it("propagates an outbox enqueue failure instead of silently dropping the event", async () => {
    const orderId = "c0000000-0000-4000-8000-0000000000f1";
    seedOrder(orderId, "DRAFT", 100);
    const failing = new PaymentService(
      paymentRepo,
      orderRepo,
      giftRepo,
      new MemoryPaymentTransactionPort(() => ({
        payments: paymentRepo,
        orders: orderRepo,
        gifts: giftRepo,
        outbox: {
          enqueue: async () => {
            throw new Error("pay_outbox_failure");
          },
        },
      })),
    );

    await expect(failing.createPaymentOrder(orderId, "cod", UID)).rejects.toThrow(
      "pay_outbox_failure",
    );
  });
});
