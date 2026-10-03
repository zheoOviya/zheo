import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus } from "@snakzap/types";
import type { EventOutboxRow } from "../repositories/eventOutboxRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";
import { MemoryOrderRepository, type OrderDTO } from "../repositories/orderRepository";
import { MemoryPaymentRepository, type PaymentDTO } from "../repositories/paymentRepository";
import { MemoryPaymentTransactionPort } from "../repositories/paymentAtomicityContracts";
import type { RazorpayPaymentEntity } from "./razorpay";
import {
  PaymentManualReviewService,
  type ManualReviewGateway,
  type ManualReviewRefundService,
} from "./paymentManualReview";
import type { RefundDisposition } from "./orderRefund";

// ============================================
// PAYMENT_CAPTURED_UNFULFILLED-B1 (PAY1, Option C): the operator manual-review
// resolution surface. MR1-MR21.
//
// B1R: the resolver is eligible ONLY for a payment reconciliation already
// flagged (manual_review=true + reconciliation_status=MANUAL_REVIEW). Ordinary
// captured payments are rejected without any gateway/order/money effect.
// ============================================

class FakeGateway implements ManualReviewGateway {
  payments: RazorpayPaymentEntity[] = [];
  reads = 0;
  throwOnRead = false;

  async fetchPayment(paymentId: string): Promise<RazorpayPaymentEntity | null> {
    this.reads += 1;
    if (this.throwOnRead) throw new Error("gateway read timeout");
    return this.payments.find((p) => p.id === paymentId) ?? null;
  }
}

class FakeRefundService implements ManualReviewRefundService {
  calls: string[] = [];
  result: RefundDisposition = "SUBMITTED";

  async submitFullRefundForCapturedPayment(paymentId: string): Promise<RefundDisposition> {
    this.calls.push(paymentId);
    return this.result;
  }
}

function entity(
  id: string,
  orderId: string,
  amountPaise: number,
  overrides: Partial<RazorpayPaymentEntity> = {},
): RazorpayPaymentEntity {
  return {
    id,
    order_id: orderId,
    amount: amountPaise,
    currency: "INR",
    status: "captured",
    captured: true,
    method: "upi",
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderDTO> = {}): OrderDTO {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: randomUUID(),
    restaurant_id: randomUUID(),
    items: [],
    total_amount: 100,
    status: "PAYMENT_FAILED" as OrderStatus,
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

describe("PaymentManualReviewService (PAY1 Option C)", () => {
  let orderRepo: MemoryOrderRepository;
  let paymentRepo: MemoryPaymentRepository;
  let giftRepo: MemoryGiftRepository;
  let gateway: FakeGateway;
  let refunds: FakeRefundService;
  let service: PaymentManualReviewService;

  beforeEach(() => {
    memoryEventOutbox._reset();
    orderRepo = new MemoryOrderRepository();
    paymentRepo = new MemoryPaymentRepository();
    giftRepo = new MemoryGiftRepository();
    gateway = new FakeGateway();
    refunds = new FakeRefundService();
    service = new PaymentManualReviewService({
      orderRepo,
      paymentRepo,
      giftRepo,
      gateway,
      refundService: refunds,
      txPort: new MemoryPaymentTransactionPort(() => ({
        payments: paymentRepo,
        orders: orderRepo,
        gifts: giftRepo,
        outbox: memoryEventOutbox,
      })),
    });
  });

  function seedOrder(overrides: Partial<OrderDTO> = {}): OrderDTO {
    return orderRepo._seed(makeOrder(overrides));
  }

  async function seedCapturedPayment(
    order: OrderDTO,
    paymentId = `pay_${order.id.slice(0, 8)}`,
  ): Promise<PaymentDTO> {
    const created = await paymentRepo.create({
      order_id: order.id,
      razorpay_order_id: `order_${order.id.slice(0, 8)}`,
      amount: order.total_amount,
    });
    await paymentRepo.compareAndSetStatus(created.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: paymentId,
    });
    return (await paymentRepo.getById(created.id))!;
  }

  /** Marks an existing payment as a reconciliation manual-review candidate. */
  async function markManualReview(payment: PaymentDTO): Promise<PaymentDTO> {
    await paymentRepo.markReconciliationResult(payment.id, {
      reconciliation_status: "MANUAL_REVIEW",
      reconciliation_reason: "PAYMENT_FAILED_RECOVERY_INTEGRITY_FAILED",
      last_reconciled_at: new Date().toISOString(),
      manual_review: true,
    });
    return (await paymentRepo.getById(payment.id))!;
  }

  /** Captured AND already flagged for manual review (the only eligible input). */
  async function seedManualReviewPayment(
    order: OrderDTO,
    paymentId?: string,
  ): Promise<PaymentDTO> {
    const payment = await seedCapturedPayment(order, paymentId);
    return markManualReview(payment);
  }

  function enqueued(name: "PaymentSucceeded"): () => EventOutboxRow[] {
    return () => memoryEventOutbox._all().filter((row) => row.event_name === name);
  }

  // MR1: an eligible (manual-review) PAYMENT_FAILED order recovers to CONFIRMED.
  it("MR1 PAYMENT_FAILED + eligible manual-review capture -> RECOVER_TO_CONFIRMED -> CONFIRMED + event", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedManualReviewPayment(order);
    gateway.payments.push(entity(payment.razorpay_payment_id!, payment.razorpay_order_id, 10000));
    const events = enqueued("PaymentSucceeded");

    const result = await service.resolve(order.id, {
      action: "RECOVER_TO_CONFIRMED",
      from_status: "PAYMENT_FAILED",
    });

    expect(result.action).toBe("RECOVER_TO_CONFIRMED");
    expect(result.order_status).toBe("CONFIRMED");
    expect(result.from_status).toBe("PAYMENT_FAILED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
    expect(events()).toHaveLength(1);
  });

  // MR2: mutating actions require the operator-observed from_status.
  it("MR2 RECOVER without from_status -> VALIDATION_ERROR", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    await seedManualReviewPayment(order);

    await expect(service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
    expect(gateway.reads).toBe(0);
  });

  // MR3: a stale from_status precondition is rejected before any read/mutation.
  it("MR3 RECOVER from_status mismatch -> CONCURRENT_MODIFICATION, no mutation", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    await seedManualReviewPayment(order);

    await expect(
      service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED", from_status: "DRAFT" }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION", status: 409 });

    expect(gateway.reads).toBe(0);
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
  });

  // MR4: only DRAFT / PAYMENT_PENDING / PAYMENT_FAILED may recover.
  it("MR4 RECOVER from a non-recoverable status -> INVALID_TRANSITION", async () => {
    const order = seedOrder({ status: "READY_FOR_PICKUP" });
    await seedManualReviewPayment(order);

    await expect(
      service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED", from_status: "READY_FOR_PICKUP" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 400 });

    expect((await orderRepo.getById(order.id))!.status).toBe("READY_FOR_PICKUP");
  });

  // MR5: a DRAFT catering order needs the B2B approval contract, not an override.
  it("MR5 RECOVER DRAFT catering -> CATERING_APPROVAL_REQUIRED, order stays DRAFT", async () => {
    const order = seedOrder({ status: "DRAFT", is_catering: true });
    const payment = await seedManualReviewPayment(order);
    gateway.payments.push(entity(payment.razorpay_payment_id!, payment.razorpay_order_id, 10000));

    await expect(
      service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED", from_status: "DRAFT" }),
    ).rejects.toMatchObject({ code: "CATERING_APPROVAL_REQUIRED", status: 409 });

    expect((await orderRepo.getById(order.id))!.status).toBe("DRAFT");
  });

  // MR6: a non-catering DRAFT with a proven capture may recover.
  it("MR6 RECOVER DRAFT (non-catering) + valid capture -> CONFIRMED", async () => {
    const order = seedOrder({ status: "DRAFT", is_catering: false });
    const payment = await seedManualReviewPayment(order);
    gateway.payments.push(entity(payment.razorpay_payment_id!, payment.razorpay_order_id, 10000));

    const result = await service.resolve(order.id, {
      action: "RECOVER_TO_CONFIRMED",
      from_status: "DRAFT",
    });

    expect(result.order_status).toBe("CONFIRMED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
  });

  // MR7: gateway amount disagreement blocks recovery (PAY4 revalidation).
  it("MR7 RECOVER gateway amount mismatch -> CAPTURE_INTEGRITY_VIOLATION, no mutation", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedManualReviewPayment(order);
    gateway.payments.push(entity(payment.razorpay_payment_id!, payment.razorpay_order_id, 9999));

    await expect(
      service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED", from_status: "PAYMENT_FAILED" }),
    ).rejects.toMatchObject({ code: "CAPTURE_INTEGRITY_VIOLATION", status: 409 });

    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
  });

  // MR8: a locally-CAPTURED payment with no gateway truth fails closed.
  it("MR8 RECOVER missing gateway entity -> CAPTURE_INTEGRITY_VIOLATION", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    await seedManualReviewPayment(order);

    await expect(
      service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED", from_status: "PAYMENT_FAILED" }),
    ).rejects.toMatchObject({ code: "CAPTURE_INTEGRITY_VIOLATION", status: 409 });

    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
  });

  // MR9: an infrastructure gateway error is a rejection, never a mutation.
  it("MR9 RECOVER gateway read throws -> CAPTURE_INTEGRITY_UNVERIFIABLE, no mutation", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    await seedManualReviewPayment(order);
    gateway.throwOnRead = true;

    await expect(
      service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED", from_status: "PAYMENT_FAILED" }),
    ).rejects.toMatchObject({ code: "CAPTURE_INTEGRITY_UNVERIFIABLE", status: 409 });

    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
  });

  // MR10: a non-CAPTURED payment can never be recovered.
  it("MR10 RECOVER with a non-CAPTURED payment -> PAYMENT_NOT_CAPTURED", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const created = await paymentRepo.create({
      order_id: order.id,
      razorpay_order_id: `order_${order.id.slice(0, 8)}`,
      amount: order.total_amount,
    });
    expect(created.status).toBe("CREATED");

    await expect(
      service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED", from_status: "PAYMENT_FAILED" }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_CAPTURED", status: 409 });

    expect(gateway.reads).toBe(0);
  });

  // MR11: FULL_REFUND delegates to the shared choke point; order is untouched.
  it("MR11 FULL_REFUND -> delegates to shared refund service, no order mutation", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedManualReviewPayment(order);
    gateway.payments.push(entity(payment.razorpay_payment_id!, payment.razorpay_order_id, 10000));
    refunds.result = "SUBMITTED";

    const result = await service.resolve(order.id, {
      action: "FULL_REFUND",
      from_status: "PAYMENT_FAILED",
    });

    expect(refunds.calls).toEqual([payment.id]);
    expect(result.refund).toBe("SUBMITTED");
    expect(result.order_status).toBe("PAYMENT_FAILED");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
  });

  // MR12: a failed revalidation blocks the refund delegation entirely.
  it("MR12 FULL_REFUND integrity failure -> no refund call", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedManualReviewPayment(order);
    gateway.payments.push(entity(payment.razorpay_payment_id!, payment.razorpay_order_id, 9999));

    await expect(
      service.resolve(order.id, { action: "FULL_REFUND", from_status: "PAYMENT_FAILED" }),
    ).rejects.toMatchObject({ code: "CAPTURE_INTEGRITY_VIOLATION", status: 409 });

    expect(refunds.calls).toHaveLength(0);
  });

  // MR13: KEEP_MANUAL_REVIEW records only a reconciliation reason; no money, no
  // order mutation, no gateway call, no event.
  it("MR13 KEEP_MANUAL_REVIEW -> reason recorded, no gateway/order/event mutation", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedManualReviewPayment(order);
    const events = enqueued("PaymentSucceeded");

    const result = await service.resolve(order.id, {
      action: "KEEP_MANUAL_REVIEW",
      reason: "OPERATOR_INVESTIGATING",
    });

    expect(result.order_status).toBe("PAYMENT_FAILED");
    expect(result.payment_status).toBe("CAPTURED");
    expect(gateway.reads).toBe(0);
    expect(refunds.calls).toHaveLength(0);
    expect(events()).toHaveLength(0);
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
    const after = (await paymentRepo.getById(payment.id))!;
    expect(after.status).toBe("CAPTURED");
    expect(after.manual_review).toBe(true);
    expect(after.reconciliation_status).toBe("MANUAL_REVIEW");
    expect(after.reconciliation_reason).toBe("OPERATOR_INVESTIGATING");
  });

  // MR14: unknown order surfaces the truthful 404 before anything else.
  it("MR14 unknown order -> ORDER_NOT_FOUND", async () => {
    await expect(
      service.resolve(randomUUID(), { action: "KEEP_MANUAL_REVIEW" }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND", status: 404 });
  });

  // MR15: an order with no payment cannot be recovered.
  it("MR15 order without a payment -> PAYMENT_NOT_FOUND", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });

    await expect(
      service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED", from_status: "PAYMENT_FAILED" }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND", status: 404 });
  });

  // ============================================
  // B1R eligibility guard: an ordinary captured payment that reconciliation did
  // NOT flag must never be resolvable, and a call must never manufacture the
  // manual-review state.
  // ============================================

  // MR16: ordinary captured + PAYMENT_FAILED is rejected before any gateway read.
  it("MR16 ordinary CAPTURED + PAYMENT_FAILED, not manual-review -> RECOVER rejected", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedCapturedPayment(order);
    gateway.payments.push(entity(payment.razorpay_payment_id!, payment.razorpay_order_id, 10000));
    const events = enqueued("PaymentSucceeded");

    await expect(
      service.resolve(order.id, { action: "RECOVER_TO_CONFIRMED", from_status: "PAYMENT_FAILED" }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_IN_MANUAL_REVIEW", status: 409 });

    expect(gateway.reads).toBe(0);
    expect(events()).toHaveLength(0);
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
  });

  // MR17: ordinary captured is rejected before the refund delegation.
  it("MR17 ordinary CAPTURED, not manual-review -> FULL_REFUND rejected, no refund call", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    await seedCapturedPayment(order);

    await expect(
      service.resolve(order.id, { action: "FULL_REFUND", from_status: "PAYMENT_FAILED" }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_IN_MANUAL_REVIEW", status: 409 });

    expect(refunds.calls).toHaveLength(0);
    expect(gateway.reads).toBe(0);
  });

  // MR18: KEEP must not manufacture a manual-review state.
  it("MR18 ordinary CAPTURED, not manual-review -> KEEP rejected, no state manufactured", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedCapturedPayment(order);

    await expect(
      service.resolve(order.id, { action: "KEEP_MANUAL_REVIEW", reason: "try-manufacture" }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_IN_MANUAL_REVIEW", status: 409 });

    const after = (await paymentRepo.getById(payment.id))!;
    expect(after.manual_review).toBe(false);
    expect(after.reconciliation_status).toBe("NONE");
  });

  // MR19: an eligible candidate still recovers after full PAY4 validation.
  it("MR19 eligible CAPTURED + manual-review -> RECOVER still works", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedManualReviewPayment(order);
    gateway.payments.push(entity(payment.razorpay_payment_id!, payment.razorpay_order_id, 10000));

    const result = await service.resolve(order.id, {
      action: "RECOVER_TO_CONFIRMED",
      from_status: "PAYMENT_FAILED",
    });

    expect(result.order_status).toBe("CONFIRMED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
  });

  // MR20: an eligible candidate still delegates FULL_REFUND exactly once.
  it("MR20 eligible CAPTURED + manual-review -> FULL_REFUND delegates exactly once", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedManualReviewPayment(order);
    gateway.payments.push(entity(payment.razorpay_payment_id!, payment.razorpay_order_id, 10000));

    const result = await service.resolve(order.id, {
      action: "FULL_REFUND",
      from_status: "PAYMENT_FAILED",
    });

    expect(refunds.calls).toEqual([payment.id]);
    expect(result.refund).toBe("SUBMITTED");
  });

  // MR21: an eligible candidate may only refresh the reason.
  it("MR21 eligible CAPTURED + manual-review -> KEEP may update reason only", async () => {
    const order = seedOrder({ status: "PAYMENT_FAILED" });
    const payment = await seedManualReviewPayment(order);

    const result = await service.resolve(order.id, {
      action: "KEEP_MANUAL_REVIEW",
      reason: "OPERATOR_UPDATE",
    });

    expect(result.order_status).toBe("PAYMENT_FAILED");
    const after = (await paymentRepo.getById(payment.id))!;
    expect(after.status).toBe("CAPTURED");
    expect(after.manual_review).toBe(true);
    expect(after.reconciliation_status).toBe("MANUAL_REVIEW");
    expect(after.reconciliation_reason).toBe("OPERATOR_UPDATE");
  });
});
