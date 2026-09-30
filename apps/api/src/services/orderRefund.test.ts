import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus } from "@snakzap/types";
import { MemoryOrderRepository, type OrderDTO } from "../repositories/orderRepository";
import {
  MemoryPaymentRepository,
  type PaymentDTO,
  type ReserveRefundSubmissionResult,
} from "../repositories/paymentRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { MemoryFulfillmentTransactionPort } from "../repositories/fulfillmentAtomicityContracts";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";
import { OrderRefundService, type OrderRefundGateway } from "./orderRefund";

// ============================================
// PAYMENT_CANCEL_REFUND-B1 (PAY2-B): the single cancellation + refund choke
// point. CR1-CR8, CR15, CR21, CR22 at the service boundary. Route, webhook and
// reconciliation integration live in their own suites.
// ============================================

class FakeRefundGateway implements OrderRefundGateway {
  calls: Array<{ paymentId: string; amountInPaise: number }> = [];
  behavior: "success" | "throw" = "success";
  nextId = "rfnd_test_0001";

  async refund(paymentId: string, amountInPaise: number): Promise<{ id: string; status: string }> {
    this.calls.push({ paymentId, amountInPaise });
    if (this.behavior === "throw") {
      throw new Error("gateway timeout");
    }
    return { id: this.nextId, status: "processed" };
  }

  get count(): number {
    return this.calls.length;
  }
}

class RacingOrderRepository extends MemoryOrderRepository {
  raceTo: OrderStatus | null = null;

  override async transitionStatus(
    orderId: string,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
  ): Promise<OrderDTO | null> {
    if (this.raceTo) {
      const target = this.raceTo;
      this.raceTo = null;
      await this.updateStatus(orderId, target);
      return null;
    }
    return super.transitionStatus(orderId, fromStatus, toStatus);
  }
}

// Deterministic interleaving seam for the reservation-owner races (R27/R28).
// It parks a caller AFTER it has won the reservation but BEFORE it returns,
// letting a second caller run its full reserve + order CAS in between.
class GatedPaymentRepository extends MemoryPaymentRepository {
  consumed: Promise<void> = Promise.resolve();
  private armed = false;
  private gate: Promise<void> = Promise.resolve();
  private openGate: (() => void) | null = null;
  private signalConsumed: (() => void) | null = null;

  blockNextReservation(): void {
    this.armed = true;
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
    this.consumed = new Promise<void>((resolve) => {
      this.signalConsumed = resolve;
    });
  }

  releaseReservation(): void {
    this.openGate?.();
  }

  override async reserveRefundSubmission(
    paymentId: string,
    expectedStatus: PaymentDTO["status"] = "CAPTURED",
  ): Promise<ReserveRefundSubmissionResult> {
    const result = await super.reserveRefundSubmission(paymentId, expectedStatus);
    if (this.armed) {
      this.armed = false;
      this.signalConsumed?.();
      await this.gate;
    }
    return result;
  }
}

const REST_ID = "33333333-3333-4333-8333-333333333333";

function makeOrder(overrides: Partial<OrderDTO> = {}): OrderDTO {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: randomUUID(),
    restaurant_id: REST_ID,
    items: [],
    total_amount: 100,
    status: "CONFIRMED" as OrderStatus,
    commission_rate: 0.08,
    commission_amount: 8,
    pickup_otp: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("OrderRefundService cancellation + refund choke point (PAY2-B)", () => {
  let orders: RacingOrderRepository;
  let payments: GatedPaymentRepository;
  let gifts: MemoryGiftRepository;
  let gateway: FakeRefundGateway;
  let service: OrderRefundService;

  beforeEach(() => {
    orders = new RacingOrderRepository();
    payments = new GatedPaymentRepository();
    gifts = new MemoryGiftRepository();
    gateway = new FakeRefundGateway();
    const port = new MemoryFulfillmentTransactionPort(() => ({
      orders,
      gifts,
      outbox: memoryEventOutbox,
    }));
    service = new OrderRefundService(orders, payments, gateway, port);
  });

  function seedOrder(overrides: Partial<OrderDTO> = {}): OrderDTO {
    return orders._seed(makeOrder(overrides));
  }

  async function seedPayment(
    order: OrderDTO,
    status: PaymentDTO["status"],
    opts: { razorpayPaymentId?: string | null } = {},
  ): Promise<PaymentDTO> {
    const created = await payments.create({
      order_id: order.id,
      razorpay_order_id: `order_${order.id.slice(0, 8)}`,
      amount: order.total_amount,
    });
    if (status === "CREATED") return created;
    if (status === "CAPTURED") {
      // `razorpayPaymentId: null` captures the payment WITHOUT a gateway id
      // (the R29 corrupt-identity case); passing no patch leaves the column null.
      await payments.compareAndSetStatus(
        created.id,
        "CREATED",
        "CAPTURED",
        opts.razorpayPaymentId === null
          ? undefined
          : { razorpay_payment_id: opts.razorpayPaymentId ?? `pay_${order.id.slice(0, 8)}` },
      );
    } else if (status === "FAILED") {
      await payments.updateWebhookResult(created.id, {
        razorpay_payment_id: opts.razorpayPaymentId ?? `pay_${order.id.slice(0, 8)}`,
        status: "FAILED",
        method: "upi",
        webhook_event: "payment.failed",
        webhook_raw: null,
      });
    } else if (status === "REFUNDED") {
      await payments.updateWebhookResult(created.id, {
        razorpay_payment_id: opts.razorpayPaymentId ?? `pay_${order.id.slice(0, 8)}`,
        status: "REFUNDED",
        method: "upi",
        webhook_event: "refund.processed",
        webhook_raw: null,
      });
    }
    return (await payments.getById(created.id))!;
  }

  // CR1: a DRAFT order (no payment) cancels with no refund.
  it("CR1 DRAFT cancellation -> CANCELLED, no refund", async () => {
    const order = seedOrder({ status: "DRAFT" });
    const result = await service.cancelOrder(order.id);
    expect(result.order.status).toBe("CANCELLED");
    expect(result.refund).toBe("NOT_REQUIRED");
    expect(gateway.count).toBe(0);
  });

  // CR1b: a COD order is payment CREATED (never captured) -> no refund.
  it("CR1b COD-style cancellation (payment CREATED) -> CANCELLED, no refund", async () => {
    const order = seedOrder({ status: "CONFIRMED" });
    await seedPayment(order, "CREATED");
    const result = await service.cancelOrder(order.id);
    expect(result.order.status).toBe("CANCELLED");
    expect(result.refund).toBe("NOT_REQUIRED");
    expect(gateway.count).toBe(0);
  });

  // CR2: an unpaid online order (PAYMENT_PENDING) cancels with no refund.
  it("CR2 PAYMENT_PENDING cancellation -> CANCELLED, no refund", async () => {
    const order = seedOrder({ status: "PAYMENT_PENDING" });
    await seedPayment(order, "CREATED");
    const result = await service.cancelOrder(order.id);
    expect(result.order.status).toBe("CANCELLED");
    expect(result.refund).toBe("NOT_REQUIRED");
    expect(gateway.count).toBe(0);
  });

  // CR3: CAPTURED + CONFIRMED -> exactly one full refund submission.
  it("CR3 CAPTURED + CONFIRMED vendor cancel -> exactly one full refund submission", async () => {
    const order = seedOrder({ status: "CONFIRMED", total_amount: 250 });
    const payment = await seedPayment(order, "CAPTURED");

    const result = await service.cancelOrder(order.id);

    expect(result.order.status).toBe("CANCELLED");
    expect(result.refund).toBe("SUBMITTED");
    expect(gateway.count).toBe(1);
    expect(gateway.calls[0]).toEqual({
      paymentId: payment.razorpay_payment_id,
      amountInPaise: 25000,
    });
    const after = (await payments.getById(payment.id))!;
    expect(after.refund_initiation_status).toBe("SUBMITTED");
    expect(after.refund_provider_id).toBe("rfnd_test_0001");
    expect(after.refund_requested_at).not.toBeNull();
    // The payment stays CAPTURED until webhook/reconciliation truth confirms.
    expect(after.status).toBe("CAPTURED");
  });

  // CR4: CAPTURED + PREPARING -> exactly one full refund submission.
  it("CR4 CAPTURED + PREPARING vendor cancel -> exactly one full refund submission", async () => {
    const order = seedOrder({ status: "PREPARING" });
    const payment = await seedPayment(order, "CAPTURED");
    const result = await service.cancelOrder(order.id);
    expect(result.order.status).toBe("CANCELLED");
    expect(gateway.count).toBe(1);
    expect(gateway.calls[0]!.amountInPaise).toBe(10000);
    expect((await payments.getById(payment.id))!.refund_initiation_status).toBe("SUBMITTED");
  });

  // CR5: duplicate cancel never fires a second refund.
  it("CR5 duplicate cancel -> no second refund", async () => {
    const order = seedOrder({ status: "CONFIRMED" });
    await seedPayment(order, "CAPTURED");

    const first = await service.cancelOrder(order.id);
    const second = await service.cancelOrder(order.id);

    expect(first.refund).toBe("SUBMITTED");
    expect(second.idempotent).toBe(true);
    expect(gateway.count).toBe(1);
  });

  // CR6: two concurrent cancels -> at most one gateway refund POST.
  it("CR6 two concurrent cancels -> at most one gateway refund POST", async () => {
    const order = seedOrder({ status: "CONFIRMED" });
    await seedPayment(order, "CAPTURED");

    const results = await Promise.allSettled([
      service.cancelOrder(order.id),
      service.cancelOrder(order.id),
    ]);

    expect(gateway.count).toBe(1);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await orders.getById(order.id))!.status).toBe("CANCELLED");
  });

  // CR7: ambiguous gateway timeout -> reservation retained, MANUAL_REVIEW, no retry POST.
  it("CR7 refund gateway timeout -> reservation retained, MANUAL_REVIEW, no second POST", async () => {
    const order = seedOrder({ status: "CONFIRMED" });
    const payment = await seedPayment(order, "CAPTURED");
    gateway.behavior = "throw";

    const result = await service.cancelOrder(order.id);

    expect(result.order.status).toBe("CANCELLED");
    expect(result.refund).toBe("SUBMISSION_FAILED");
    expect(gateway.count).toBe(1);
    const after = (await payments.getById(payment.id))!;
    expect(after.refund_requested_at).not.toBeNull();
    expect(after.refund_initiation_status).toBe("MANUAL_REVIEW");
    expect(after.refund_initiation_reason).toBe("AMBIGUOUS_REFUND_SUBMISSION");
    expect(after.status).toBe("CAPTURED");

    // A retry sees a terminal order and never triggers a second POST.
    const retry = await service.cancelOrder(order.id);
    expect(retry.idempotent).toBe(true);
    expect(gateway.count).toBe(1);
  });

  // CR8: gateway success -> SUBMITTED + provider id; payment stays CAPTURED.
  it("CR8 gateway success -> SUBMITTED + provider refund id, payment remains CAPTURED", async () => {
    const order = seedOrder({ status: "CONFIRMED" });
    const payment = await seedPayment(order, "CAPTURED");
    gateway.nextId = "rfnd_cr8";
    await service.cancelOrder(order.id);
    const after = (await payments.getById(payment.id))!;
    expect(after.refund_initiation_status).toBe("SUBMITTED");
    expect(after.refund_provider_id).toBe("rfnd_cr8");
    expect(after.refund_initiation_reason).toBeNull();
    expect(after.status).toBe("CAPTURED");
  });

  // CR15: already-terminal cancellation retries are idempotent with no POST.
  it("CR15 already CANCELLED / REFUNDED retry -> idempotent, no refund POST", async () => {
    const cancelled = seedOrder({ status: "CANCELLED" });
    await seedPayment(cancelled, "CAPTURED");
    const r1 = await service.cancelOrder(cancelled.id);
    expect(r1.idempotent).toBe(true);

    const refunded = seedOrder({ status: "REFUNDED" });
    await seedPayment(refunded, "REFUNDED");
    const r2 = await service.cancelOrder(refunded.id);
    expect(r2.idempotent).toBe(true);

    expect(gateway.count).toBe(0);
  });

  // CR21: cancellation loses the CAS -> no POST; reservation retained/flagged.
  it("CR21 cancellation CAS loss -> no refund POST; reservation retained/flagged", async () => {
    const order = seedOrder({ status: "CONFIRMED" });
    const payment = await seedPayment(order, "CAPTURED");
    orders.raceTo = "READY_FOR_PICKUP";

    await expect(service.cancelOrder(order.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      status: 400,
    });

    expect(gateway.count).toBe(0);
    const after = (await payments.getById(payment.id))!;
    expect(after.refund_requested_at).not.toBeNull();
    expect(after.refund_initiation_status).toBe("MANUAL_REVIEW");
    expect(after.refund_initiation_reason).toBe("CANCEL_CAS_LOST");
  });

  // CR22: a payment belonging to another order is never refunded.
  it("CR22 a foreign/unrelated payment is never refunded", async () => {
    const paidOrder = seedOrder({ status: "CONFIRMED" });
    const payment = await seedPayment(paidOrder, "CAPTURED");
    const otherOrder = seedOrder({ status: "CONFIRMED" });

    const result = await service.cancelOrder(otherOrder.id);

    expect(result.order.status).toBe("CANCELLED");
    expect(result.refund).toBe("NOT_REQUIRED");
    expect(gateway.count).toBe(0);
    expect((await payments.getById(payment.id))!.refund_requested_at).toBeNull();
  });

  // R27/B1R: the ALREADY_RESERVED caller wins the order CAS; the reservation
  // OWNER loses it. The owner must still perform the one authorized refund POST.
  it("R27 concurrent cancels: ALREADY_RESERVED caller wins CAS, owner still POSTs once", async () => {
    const order = seedOrder({ status: "CONFIRMED" });
    const payment = await seedPayment(order, "CAPTURED");

    payments.blockNextReservation();
    const owner = service.cancelOrder(order.id);
    await payments.consumed; // owner holds RESERVED, parked before its CAS

    const loser = await service.cancelOrder(order.id); // ALREADY_RESERVED, wins CAS
    payments.releaseReservation();
    const ownerResult = await owner;

    expect(loser.refund).toBe("ALREADY_RESERVED");
    expect(loser.idempotent).toBe(false);
    expect(ownerResult.refund).toBe("SUBMITTED");
    expect(ownerResult.idempotent).toBe(false);
    expect(gateway.count).toBe(1);
    expect((await orders.getById(order.id))!.status).toBe("CANCELLED");
    expect((await payments.getById(payment.id))!.refund_initiation_status).toBe("SUBMITTED");
  });

  // R28/B1R: the reservation owner loses the CAS to a concurrent CANCELLED and
  // must NOT be returned as a harmless idempotent before submitting.
  it("R28 reservation owner loses CAS to concurrent CANCELLED -> still one refund POST", async () => {
    const order = seedOrder({ status: "CONFIRMED" });
    const payment = await seedPayment(order, "CAPTURED");

    payments.blockNextReservation();
    const owner = service.cancelOrder(order.id);
    await payments.consumed; // owner holds RESERVED, parked before its CAS
    await orders.updateStatus(order.id, "CANCELLED"); // concurrent canceller wins
    payments.releaseReservation();
    const result = await owner;

    expect(result.idempotent).toBe(false);
    expect(result.refund).toBe("SUBMITTED");
    expect(gateway.count).toBe(1);
    expect((await orders.getById(order.id))!.status).toBe("CANCELLED");
    expect((await payments.getById(payment.id))!.refund_initiation_status).toBe("SUBMITTED");
  });

  // R29/B1R: CAPTURED with no gateway payment id fails closed; never NOT_REQUIRED.
  it("R29 CAPTURED + missing razorpay_payment_id -> fail closed, no POST, MANUAL_REVIEW", async () => {
    const order = seedOrder({ status: "CONFIRMED" });
    const payment = await seedPayment(order, "CAPTURED", { razorpayPaymentId: null });

    await expect(service.cancelOrder(order.id)).rejects.toMatchObject({
      code: "PAYMENT_IDENTITY_MISSING",
      status: 409,
    });

    expect(gateway.count).toBe(0);
    expect((await orders.getById(order.id))!.status).toBe("CONFIRMED");
    const after = (await payments.getById(payment.id))!;
    expect(after.refund_requested_at).toBeNull();
    expect(after.refund_initiation_status).toBe("MANUAL_REVIEW");
    expect(after.refund_initiation_reason).toBe("CAPTURED_MISSING_PAYMENT_ID");
  });

  // R32/B1R (service-level): an expected-from mismatch is a precondition failure
  // before any reservation.
  it("expected-from mismatch -> CONCURRENT_MODIFICATION before reservation", async () => {
    const order = seedOrder({ status: "PREPARING" });
    const payment = await seedPayment(order, "CAPTURED");

    await expect(service.cancelOrder(order.id, "CONFIRMED")).rejects.toMatchObject({
      code: "CONCURRENT_MODIFICATION",
      status: 409,
    });

    expect(gateway.count).toBe(0);
    expect((await orders.getById(order.id))!.status).toBe("PREPARING");
    expect((await payments.getById(payment.id))!.refund_requested_at).toBeNull();
  });

  // CR21b: non-cancellable status is rejected before any reservation.
  it("rejects a non-cancellable status without touching the payment", async () => {
    const order = seedOrder({ status: "READY_FOR_PICKUP" });
    const payment = await seedPayment(order, "CAPTURED");
    await expect(service.cancelOrder(order.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    expect(gateway.count).toBe(0);
    expect((await payments.getById(payment.id))!.refund_requested_at).toBeNull();
  });

  // Missing order surfaces the truthful 404.
  it("missing order -> ORDER_NOT_FOUND", async () => {
    await expect(service.cancelOrder(randomUUID())).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      status: 404,
    });
  });

  // ============================================
  // PAY1 (PAYMENT_CAPTURED_UNFULFILLED-B1): operator FULL_REFUND entry into the
  // SAME choke point. No order mutation; exactly-once; fail-closed identity.
  // ============================================

  describe("submitFullRefundForCapturedPayment (PAY1 operator full refund)", () => {
    async function seedCapturedOrder(): Promise<{ order: OrderDTO; payment: PaymentDTO }> {
      const order = seedOrder({ status: "CONFIRMED", total_amount: 250 });
      const payment = await seedPayment(order, "CAPTURED");
      return { order, payment };
    }

    // FR1: one full refund POST; reservation set; payment stays CAPTURED.
    it("FR1 CAPTURED -> SUBMITTED, exactly one full POST, payment stays CAPTURED", async () => {
      const { payment } = await seedCapturedOrder();
      gateway.nextId = "rfnd_fr1";

      const result = await service.submitFullRefundForCapturedPayment(payment.id);

      expect(result).toBe("SUBMITTED");
      expect(gateway.count).toBe(1);
      expect(gateway.calls[0]).toEqual({
        paymentId: payment.razorpay_payment_id,
        amountInPaise: 25000,
      });
      const after = (await payments.getById(payment.id))!;
      expect(after.refund_initiation_status).toBe("SUBMITTED");
      expect(after.refund_provider_id).toBe("rfnd_fr1");
      expect(after.refund_requested_at).not.toBeNull();
      expect(after.status).toBe("CAPTURED");
    });

    // FR2: duplicate operator refund never fires a second POST.
    it("FR2 second call -> ALREADY_RESERVED, no second POST", async () => {
      const { payment } = await seedCapturedOrder();
      const first = await service.submitFullRefundForCapturedPayment(payment.id);
      const second = await service.submitFullRefundForCapturedPayment(payment.id);

      expect(first).toBe("SUBMITTED");
      expect(second).toBe("ALREADY_RESERVED");
      expect(gateway.count).toBe(1);
    });

    // FR3: a non-CAPTURED payment is refused before any reservation.
    it("FR3 non-CAPTURED payment -> PAYMENT_NOT_CAPTURED, no POST, no reservation", async () => {
      const order = seedOrder({ status: "CONFIRMED" });
      const payment = await seedPayment(order, "CREATED");

      await expect(service.submitFullRefundForCapturedPayment(payment.id)).rejects.toMatchObject({
        code: "PAYMENT_NOT_CAPTURED",
        status: 409,
      });

      expect(gateway.count).toBe(0);
      expect((await payments.getById(payment.id))!.refund_requested_at).toBeNull();
    });

    // FR4: a CAPTURED payment with no gateway id fails closed, no reservation.
    it("FR4 CAPTURED + missing gateway id -> PAYMENT_IDENTITY_MISSING, no POST/reservation", async () => {
      const order = seedOrder({ status: "CONFIRMED" });
      const payment = await seedPayment(order, "CAPTURED", { razorpayPaymentId: null });

      await expect(service.submitFullRefundForCapturedPayment(payment.id)).rejects.toMatchObject({
        code: "PAYMENT_IDENTITY_MISSING",
        status: 409,
      });

      expect(gateway.count).toBe(0);
      const after = (await payments.getById(payment.id))!;
      expect(after.refund_requested_at).toBeNull();
      expect(after.refund_initiation_status).toBe("MANUAL_REVIEW");
      expect(after.refund_initiation_reason).toBe("CAPTURED_MISSING_PAYMENT_ID");
    });

    // FR5: ambiguous gateway failure retains the reservation; a retry cannot POST.
    it("FR5 ambiguous gateway failure -> SUBMISSION_FAILED, MANUAL_REVIEW, retry is ALREADY_RESERVED", async () => {
      const { payment } = await seedCapturedOrder();
      gateway.behavior = "throw";

      const result = await service.submitFullRefundForCapturedPayment(payment.id);

      expect(result).toBe("SUBMISSION_FAILED");
      expect(gateway.count).toBe(1);
      const after = (await payments.getById(payment.id))!;
      expect(after.refund_requested_at).not.toBeNull();
      expect(after.refund_initiation_status).toBe("MANUAL_REVIEW");
      expect(after.refund_initiation_reason).toBe("AMBIGUOUS_REFUND_SUBMISSION");
      expect(after.status).toBe("CAPTURED");

      gateway.behavior = "success";
      const retry = await service.submitFullRefundForCapturedPayment(payment.id);
      expect(retry).toBe("ALREADY_RESERVED");
      expect(gateway.count).toBe(1);
    });

    // FR6: unknown payment surfaces the truthful 404.
    it("FR6 missing payment -> PAYMENT_NOT_FOUND", async () => {
      await expect(service.submitFullRefundForCapturedPayment(randomUUID())).rejects.toMatchObject({
        code: "PAYMENT_NOT_FOUND",
        status: 404,
      });
    });
  });
});
