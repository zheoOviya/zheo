import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderStatus } from "@snakzap/types";
import { onEvent } from "../lib/eventBus";
import { MemoryGiftRepository, type GiftDTO } from "../repositories/giftRepository";
import { MemoryOrderRepository, type OrderDTO } from "../repositories/orderRepository";
import {
  MemoryPaymentRepository,
  type PaymentDTO,
} from "../repositories/paymentRepository";
import {
  PAYMENT_RECONCILIATION_BATCH_LIMIT,
  buildReconciliationReport,
  reconcilePayment,
  runPaymentReconciliationBatch,
  startPaymentReconciliationSweep,
  stopPaymentReconciliationSweep,
  type ReconciliationDeps,
  type ReconciliationGateway,
} from "./paymentReconciliation";
import {
  UNKNOWN_CURRENCY,
  RazorpayReadError,
  type RazorpayOrderEntity,
  type RazorpayPaymentEntity,
  type RazorpayRefundEntity,
} from "./razorpay";

// ============================================
// PAYMENT_RECONCILIATION-B1 (Gate 52683)
//
// RC1-RC20: gateway truth -> local convergence via CAS. No real network and
// no money movement: gateway reads are faked and refund submission does not
// even exist on the port.
// ============================================

class FakeGateway implements ReconciliationGateway {
  payments: RazorpayPaymentEntity[] = [];
  refunds: RazorpayRefundEntity[] = [];
  orders = new Map<string, RazorpayOrderEntity>();
  failReads: "network" | "provider" | null = null;
  batchReads = 0;
  returnAllPayments = false;
  returnAllRefunds = false;

  private maybeFail(): void {
    if (this.failReads === "network") {
      throw new RazorpayReadError("network", null, "network down");
    }
    if (this.failReads === "provider") {
      throw new RazorpayReadError("provider", 502, "bad gateway");
    }
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPaymentEntity | null> {
    this.maybeFail();
    return this.payments.find((p) => p.id === paymentId) ?? null;
  }

  async fetchOrder(razorpayOrderId: string): Promise<RazorpayOrderEntity | null> {
    this.maybeFail();
    return this.orders.get(razorpayOrderId) ?? null;
  }

  async fetchPaymentsForOrder(razorpayOrderId: string): Promise<RazorpayPaymentEntity[]> {
    this.batchReads += 1;
    this.maybeFail();
    if (this.returnAllPayments) return this.payments;
    return this.payments.filter((p) => p.order_id === razorpayOrderId);
  }

  async fetchRefund(refundId: string): Promise<RazorpayRefundEntity | null> {
    this.maybeFail();
    return this.refunds.find((r) => r.id === refundId) ?? null;
  }

  async fetchRefundsForPayment(paymentId: string): Promise<RazorpayRefundEntity[]> {
    this.maybeFail();
    if (this.returnAllRefunds) return this.refunds;
    return this.refunds.filter((r) => r.payment_id === paymentId);
  }
}

function captured(
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

function gatewayRefund(
  id: string,
  paymentId: string,
  amountPaise: number,
  overrides: Partial<RazorpayRefundEntity> = {},
): RazorpayRefundEntity {
  return { id, payment_id: paymentId, amount: amountPaise, currency: "INR", status: "processed", ...overrides };
}

function makeOrder(overrides: Partial<OrderDTO> = {}): OrderDTO {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: randomUUID(),
    restaurant_id: randomUUID(),
    items: [],
    total_amount: 100,
    status: "PAYMENT_PENDING" as OrderStatus,
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

function captureEvents(name: "PaymentSucceeded" | "GiftPaid" | "GiftRefunded"): unknown[] {
  const events: unknown[] = [];
  onEvent(name, async (event) => {
    events.push(event);
  });
  return events;
}

describe("PAYMENT_RECONCILIATION-B1 (RC1-RC20)", () => {
  let paymentRepo: MemoryPaymentRepository;
  let orderRepo: MemoryOrderRepository;
  let giftRepo: MemoryGiftRepository;
  let gateway: FakeGateway;

  beforeEach(() => {
    paymentRepo = new MemoryPaymentRepository();
    orderRepo = new MemoryOrderRepository();
    giftRepo = new MemoryGiftRepository();
    gateway = new FakeGateway();
  });

  afterEach(() => {
    stopPaymentReconciliationSweep();
    vi.restoreAllMocks();
  });

  function deps(): ReconciliationDeps {
    return { paymentRepo, orderRepo, giftRepo, gateway };
  }

  async function seedOrderPayment(
    overrides: Partial<OrderDTO>,
    paymentAmount = 100,
  ): Promise<{ order: OrderDTO; payment: PaymentDTO }> {
    const order = makeOrder({ total_amount: paymentAmount, ...overrides });
    orderRepo._seed(order);
    const payment = await paymentRepo.create({
      order_id: order.id,
      razorpay_order_id: `order_${order.id.slice(0, 8)}`,
      amount: paymentAmount,
    });
    return { order, payment };
  }

  it("RC1 CREATED + valid captured gateway payment -> CAPTURED + CONFIRMED + event", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    gateway.payments.push(captured("pay_rc1", payment.razorpay_order_id, 10000));
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect(result.emitted).toBe(true);
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("CAPTURED");
    expect(after!.razorpay_payment_id).toBe("pay_rc1");
    expect(after!.reconciliation_status).toBe("CONVERGED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect(events).toHaveLength(1);
  });

  it("RC2 local CAPTURED + PAYMENT_PENDING -> order CONFIRMED + event (payment unchanged)", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_rc2",
    });
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("CAPTURED");
    expect(after!.razorpay_payment_id).toBe("pay_rc2");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect(events).toHaveLength(1);
  });

  it("RC3 ordinary FAILED + different valid captured payment -> PAY-4 revalidated -> CAPTURED + convergence", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_bad_rc3",
      status: "FAILED",
      method: "upi",
      webhook_event: "payment.failed",
      webhook_raw: { id: "pay_bad_rc3" },
    });
    gateway.payments.push(captured("pay_good_rc3", payment.razorpay_order_id, 10000));
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("CAPTURED");
    expect(after!.razorpay_payment_id).toBe("pay_good_rc3");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect(events).toHaveLength(1);
  });

  it("RC4 amount mismatch -> remains quarantined; no order change, no event", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    gateway.payments.push(captured("pay_rc4", payment.razorpay_order_id, 9000));
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("CREATED");
    expect(after!.manual_review).toBe(true);
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_PENDING");
    expect(events).toHaveLength(0);
  });

  it("RC5 wrong currency -> remains quarantined", async () => {
    const { payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    gateway.payments.push(
      captured("pay_rc5", payment.razorpay_order_id, 10000, { currency: "USD" }),
    );
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CREATED");
    expect(events).toHaveLength(0);
  });

  it("RC6 already CAPTURED + CONFIRMED -> idempotent no-op; no duplicate event", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CONFIRMED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_rc6",
    });
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("NOOP");
    expect(result.emitted).toBe(false);
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect(events).toHaveLength(0);
  });

  it("RC7a gateway definitive failed on stale CREATED -> payment FAILED, order untouched", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    gateway.payments.push({
      id: "pay_failed_rc7",
      order_id: payment.razorpay_order_id,
      amount: 10000,
      currency: "INR",
      status: "failed",
      captured: false,
      method: "upi",
    });

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("FAILED");
    expect(after!.razorpay_payment_id).toBe("pay_failed_rc7");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_PENDING");
  });

  it("RC7b gateway failed never downgrades a locally CAPTURED payment", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CONFIRMED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_cap_rc7",
    });
    gateway.payments.push({
      id: "pay_failed_rc7b",
      order_id: payment.razorpay_order_id,
      amount: 10000,
      currency: "INR",
      status: "failed",
      captured: false,
      method: "upi",
    });

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("NOOP");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
  });

  it("RC8 unknown gateway reference -> no unsafe mutation (RETRY)", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    gateway.payments = [];

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("RETRY");
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("CREATED");
    expect(after!.reconciliation_status).toBe("RETRY");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_PENDING");
  });

  it("RC9 network/provider failure -> RETRY/ERROR; no business-state mutation", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });

    gateway.failReads = "network";
    const network = await reconcilePayment(payment.id, deps());
    expect(network.outcome).toBe("RETRY");
    expect(network.reason).toBe("GATEWAY_NETWORK");

    gateway.failReads = "provider";
    const provider = await reconcilePayment(payment.id, deps());
    expect(provider.outcome).toBe("RETRY");
    expect(provider.reason).toBe("GATEWAY_PROVIDER");

    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("CREATED");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_PENDING");
  });

  it("RC10 repeated reconciliation -> idempotent; no duplicate success event", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    gateway.payments.push(captured("pay_rc10", payment.razorpay_order_id, 10000));
    const events = captureEvents("PaymentSucceeded");

    const first = await reconcilePayment(payment.id, deps());
    const second = await reconcilePayment(payment.id, deps());

    expect(first.outcome).toBe("CONVERGED");
    expect(second.outcome).toBe("NOOP");
    expect(second.emitted).toBe(false);
    expect(events).toHaveLength(1);
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
  });

  it("RC11a gateway full refund observed -> local convergence only (never submits)", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CONFIRMED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_rc11",
    });
    gateway.refunds.push(gatewayRefund("refund_rc11", "pay_rc11", 10000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("REFUNDED");
    expect((await orderRepo.getById(order.id))!.status).toBe("REFUNDED");
    // The gateway port only exposes reads: no refund could have been submitted.
    expect("refund" in gateway).toBe(false);
  });

  it("RC11b partial gateway refund does not converge (discrepancy ignored)", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CONFIRMED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_rc11b",
    });
    gateway.refunds.push(gatewayRefund("refund_rc11b", "pay_rc11b", 9000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("NOOP");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
  });

  it("RC12 CAPTURED + CANCELLED -> MANUAL_REVIEW, no auto-refund", async () => {
    const { payment } = await seedOrderPayment({ status: "CANCELLED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_rc12",
    });

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("CAPTURED");
    expect(after!.manual_review).toBe(true);
  });

  // PAY2-B: the deliberate cancellation crash boundary.
  // CAPTURED + CANCELLED + reservation + proven full gateway refund -> converge
  // the payment to REFUNDED while the order stays the valid CANCELLED terminal.
  it("CR17 CAPTURED + CANCELLED + reservation + full gateway refund -> payment REFUNDED, order CANCELLED", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CANCELLED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_cr17",
    });
    await paymentRepo.reserveRefundSubmission(payment.id);
    gateway.refunds.push(gatewayRefund("refund_cr17", "pay_cr17", 10000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("REFUNDED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CANCELLED");
  });

  // PAY2-B: a reservation without a proven full gateway refund must never be
  // upgraded to REFUNDED.
  it("CR18 CAPTURED + CANCELLED + reservation but no confirmed refund -> not falsely REFUNDED", async () => {
    const { payment } = await seedOrderPayment({ status: "CANCELLED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_cr18",
    });
    await paymentRepo.reserveRefundSubmission(payment.id);

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    const after = (await paymentRepo.getById(payment.id))!;
    expect(after.status).toBe("CAPTURED");
    expect(after.refund_requested_at).not.toBeNull();
    expect(after.manual_review).toBe(true);
  });

  // PAY2-B: CAPTURED + CANCELLED without a reservation is the historical
  // dangerous state and must always be MANUAL_REVIEW.
  it("CR19 CAPTURED + CANCELLED without reservation -> MANUAL_REVIEW", async () => {
    const { payment } = await seedOrderPayment({ status: "CANCELLED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_cr19",
    });

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("ORDER_CANCELLED_CONFLICT");
    expect((await paymentRepo.getById(payment.id))!.refund_requested_at).toBeNull();
  });

  // PAY2-B: local REFUNDED + order CANCELLED is a valid converged terminal pair.
  it("CR20 payment REFUNDED + order CANCELLED -> reconciliation CONVERGED/no-op", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CANCELLED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_cr20",
    });
    await paymentRepo.compareAndSetStatus(payment.id, "CAPTURED", "REFUNDED", {
      gateway_status: "processed",
    });
    gateway.refunds.push(gatewayRefund("refund_cr20", "pay_cr20", 10000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("REFUNDED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CANCELLED");
  });

  // R30/B1R: PAY3 must NOT auto-converge CAPTURED + CANCELLED without the
  // durable cancellation refund reservation, even when a full gateway refund is
  // observed (out-of-band/manual refund stays visible).
  it("R30 CAPTURED + CANCELLED + full gateway refund + NO reservation -> MANUAL_REVIEW", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CANCELLED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_r30",
    });
    gateway.refunds.push(gatewayRefund("refund_r30", "pay_r30", 10000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("CANCELLED_WITHOUT_REFUND_RESERVATION");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CANCELLED");
  });

  // R31/B1R: with the reservation present, the deliberate CAPTURED + CANCELLED
  // flow still converges to REFUNDED.
  it("R31 CAPTURED + CANCELLED + reservation + full refund -> still converges", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CANCELLED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_r31",
    });
    await paymentRepo.reserveRefundSubmission(payment.id);
    gateway.refunds.push(gatewayRefund("refund_r31", "pay_r31", 10000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("REFUNDED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CANCELLED");
  });

  // ============================================
  // PAY1 (PAYMENT_CAPTURED_UNFULFILLED-B1, Option C): captured-but-unfulfilled
  // recovery. CAPTURED + PAYMENT_FAILED may only recover after a full PAY4
  // gateway revalidation; DRAFT is never auto-confirmed; CANCELLED defers to
  // PAY2.
  // ============================================

  // P1-3a: captured + PAYMENT_FAILED + proven gateway capture -> CONFIRMED.
  it("PAY1-PF1 CAPTURED + PAYMENT_FAILED + valid gateway capture -> CONFIRMED + event", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_FAILED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_pay1_pf1",
    });
    gateway.payments.push(captured("pay_pay1_pf1", payment.razorpay_order_id, 10000));
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect(result.emitted).toBe(true);
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
    expect(events).toHaveLength(1);
  });

  // P1-3b: captured + PAYMENT_FAILED but gateway amount disagrees -> no recovery.
  it("PAY1-PF2 CAPTURED + PAYMENT_FAILED + gateway amount mismatch -> MANUAL_REVIEW", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_FAILED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_pay1_pf2",
    });
    gateway.payments.push(captured("pay_pay1_pf2", payment.razorpay_order_id, 9999));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("PAYMENT_FAILED_RECOVERY_INTEGRITY_FAILED");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
    expect((await paymentRepo.getById(payment.id))!.manual_review).toBe(true);
  });

  // P1-3c: captured + PAYMENT_FAILED with no gateway entity -> fail closed.
  it("PAY1-PF3 CAPTURED + PAYMENT_FAILED + missing gateway entity -> MANUAL_REVIEW", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_FAILED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_pay1_pf3",
    });

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("PAYMENT_FAILED_RECOVERY_INTEGRITY_FAILED");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
  });

  // P1-4: captured + DRAFT is never auto-confirmed (placement semantics).
  it("PAY1-D1 CAPTURED + DRAFT -> MANUAL_REVIEW, order stays DRAFT", async () => {
    const { order, payment } = await seedOrderPayment({ status: "DRAFT" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_pay1_d1",
    });
    gateway.payments.push(captured("pay_pay1_d1", payment.razorpay_order_id, 10000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("ORDER_DRAFT_CONFLICT");
    expect((await orderRepo.getById(order.id))!.status).toBe("DRAFT");
  });

  // P1-4b: captured + CANCELLED + reservation but no proven refund defers to PAY2.
  it("PAY1-C1 CAPTURED + CANCELLED + reservation, no refund -> PAY2-deferred MANUAL_REVIEW", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CANCELLED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_pay1_c1",
    });
    await paymentRepo.reserveRefundSubmission(payment.id);

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("CANCELLED_REFUND_DEFERRED_TO_PAY2");
    expect((await orderRepo.getById(order.id))!.status).toBe("CANCELLED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
  });

  it("RC13 same PAY-4 quarantined payment id -> NEVER promoted", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_quar_rc13",
      status: "FAILED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: { id: "pay_quar_rc13", amount: 9000 },
    });
    // The quarantined id is itself captured at the gateway (but for the wrong amount).
    gateway.payments.push(captured("pay_quar_rc13", payment.razorpay_order_id, 9000));
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("SAME_PAY4_QUARANTINED_PAYMENT");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("FAILED");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_PENDING");
    expect(events).toHaveLength(0);
  });

  it("RC14 different valid payment_id after quarantine -> full revalidation then recovery", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_quar_rc14",
      status: "FAILED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: { id: "pay_quar_rc14", amount: 9000 },
    });
    gateway.payments.push(
      captured("pay_quar_rc14", payment.razorpay_order_id, 9000),
      captured("pay_valid_rc14", payment.razorpay_order_id, 10000),
    );
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("CAPTURED");
    expect(after!.razorpay_payment_id).toBe("pay_valid_rc14");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect(events).toHaveLength(1);
  });

  it("R21 ordinary payment.failed + SAME gateway id later captured -> revalidated, recovers (not quarantine)", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_r21",
      status: "FAILED",
      method: "upi",
      webhook_event: "payment.failed",
      webhook_raw: { id: "pay_r21" },
    });
    gateway.payments.push(captured("pay_r21", payment.razorpay_order_id, 10000));
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect(result.reason).not.toBe("SAME_PAY4_QUARANTINED_PAYMENT");
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("CAPTURED");
    expect(after!.razorpay_payment_id).toBe("pay_r21");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect(events).toHaveLength(1);
  });

  it("R22 payment.captured quarantine + SAME id valid capture -> still blocked, never promoted", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_r22",
      status: "FAILED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: { id: "pay_r22" },
    });
    gateway.payments.push(captured("pay_r22", payment.razorpay_order_id, 10000));
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("SAME_PAY4_QUARANTINED_PAYMENT");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("FAILED");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_PENDING");
    expect(events).toHaveLength(0);
  });

  it("R23 captured candidate with foreign order_id -> no CAPTURED, MANUAL_REVIEW, no event", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    gateway.returnAllPayments = true;
    gateway.payments.push(captured("pay_foreign_r23", "order_someone_else", 10000));
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("CAPTURE_ORDER_MISMATCH");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CREATED");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_PENDING");
    expect(events).toHaveLength(0);
  });

  it("R24 full refund with wrong payment_id -> ignored, no REFUNDED convergence", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CONFIRMED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_r24",
    });
    gateway.returnAllRefunds = true;
    gateway.refunds.push(gatewayRefund("refund_r24", "pay_OTHER", 10000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("NOOP");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
  });

  it("R25 captured candidate with missing currency never normalized to INR -> PAY-4 fails closed", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    gateway.payments.push(
      captured("pay_r25", payment.razorpay_order_id, 10000, { currency: UNKNOWN_CURRENCY }),
    );
    const events = captureEvents("PaymentSucceeded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    expect(result.reason).toBe("CAPTURE_INTEGRITY_VIOLATION");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CREATED");
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_PENDING");
    expect(events).toHaveLength(0);
  });

  it("R26 refund with missing currency is not full-refund evidence (no REFUNDED)", async () => {
    const { order, payment } = await seedOrderPayment({ status: "CONFIRMED" });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_r26",
    });
    gateway.refunds.push(
      gatewayRefund("refund_r26", "pay_r26", 10000, { currency: UNKNOWN_CURRENCY }),
    );

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("NOOP");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
  });

  it("RC15 local REFUNDED without gateway full-refund evidence -> MANUAL_REVIEW, no downgrade", async () => {
    const { payment } = await seedOrderPayment({ status: "CONFIRMED" });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_rc15",
      status: "REFUNDED",
      method: "upi",
      webhook_event: "refund.processed",
      webhook_raw: { id: "refund_rc15" },
    });
    gateway.refunds = []; // gateway proves nothing

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("MANUAL_REVIEW");
    const after = await paymentRepo.getById(payment.id);
    expect(after!.status).toBe("REFUNDED");
    expect(after!.manual_review).toBe(true);
  });

  it("RC16 sweep is bounded to the batch limit and uses the candidate repository API", async () => {
    const staleBefore = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 150; i += 1) {
      await paymentRepo.create({ razorpay_order_id: `order_rc16_${i}`, amount: 100 });
    }
    const spy = vi.spyOn(paymentRepo, "listReconciliationCandidates");

    const result = await runPaymentReconciliationBatch(deps(), { staleBefore });

    expect(result.scanned).toBe(PAYMENT_RECONCILIATION_BATCH_LIMIT);
    expect(result.scanned).toBe(100);
    expect(result.retry).toBe(100);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ limit: PAYMENT_RECONCILIATION_BATCH_LIMIT });
  });

  it("RC17 two concurrent reconciliations -> at most one transition/event", async () => {
    const { order, payment } = await seedOrderPayment({ status: "PAYMENT_PENDING" });
    gateway.payments.push(captured("pay_rc17", payment.razorpay_order_id, 10000));
    const events = captureEvents("PaymentSucceeded");

    const [a, b] = await Promise.all([
      reconcilePayment(payment.id, deps()),
      reconcilePayment(payment.id, deps()),
    ]);

    const emitted = [a, b].filter((r) => r.emitted);
    expect(emitted).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("CAPTURED");
  });

  it("RC20 scheduler start/stop is idempotent and leaves no leaked timer", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    startPaymentReconciliationSweep(60_000, deps());
    startPaymentReconciliationSweep(60_000, deps());
    expect(setSpy).toHaveBeenCalledTimes(1);

    stopPaymentReconciliationSweep();
    stopPaymentReconciliationSweep();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it("G1 gift PENDING + valid capture -> ACTIVE via gift CAS + GiftPaid", async () => {
    const gift: GiftDTO = await giftRepo.create({
      sender_id: randomUUID(),
      restaurant_id: randomUUID(),
      menu_item_id: randomUUID(),
      item_snapshot: {
        name: "Gift Item",
        price: 50,
        image_url: null,
        dietary_tags: {},
        spice_level: 1,
        customizations: [],
      },
      price_paid: 50,
      message: null,
      recipient_name: null,
      claim_token: `tok-${randomUUID()}`,
      claim_code: "GIFT1234",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_gift_g1",
      amount: 50,
    });
    gateway.payments.push(captured("pay_gift_g1", "order_gift_g1", 5000));
    const events = captureEvents("GiftPaid");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await giftRepo.getById(gift.id))!.status).toBe("ACTIVE");
    expect(events).toHaveLength(1);
  });

  it("G2 gift refund observation converges via existing gift CAS", async () => {
    const gift: GiftDTO = await giftRepo.create({
      sender_id: randomUUID(),
      restaurant_id: randomUUID(),
      menu_item_id: randomUUID(),
      item_snapshot: {
        name: "Gift Item",
        price: 50,
        image_url: null,
        dietary_tags: {},
        spice_level: 1,
        customizations: [],
      },
      price_paid: 50,
      message: null,
      recipient_name: null,
      claim_token: `tok-${randomUUID()}`,
      claim_code: "GIFT1234",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_gift_g2",
      amount: 50,
    });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_gift_g2",
    });
    await giftRepo.markPaid(gift.id);
    gateway.refunds.push(gatewayRefund("refund_gift_g2", "pay_gift_g2", 5000));
    const events = captureEvents("GiftRefunded");

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("REFUNDED");
    expect((await giftRepo.getById(gift.id))!.status).toBe("REFUNDED");
    expect(events).toHaveLength(1);
  });

  it("unknown local payment id -> ERROR (no throw)", async () => {
    const result = await reconcilePayment(randomUUID(), deps());
    expect(result.outcome).toBe("ERROR");
    expect(result.reason).toBe("PAYMENT_NOT_FOUND");
  });

  it("report is bounded and counts reconciliation statuses only", async () => {
    const staleBefore = new Date(Date.now() + 60_000).toISOString();
    const a = await paymentRepo.create({ razorpay_order_id: "order_rep_1", amount: 100 });
    await paymentRepo.markReconciliationResult(a.id, {
      reconciliation_status: "MANUAL_REVIEW",
      manual_review: true,
      last_reconciled_at: new Date().toISOString(),
    });
    const report = await buildReconciliationReport(deps(), { limit: 1 });
    expect(report.candidates).toBe(1);
    expect(report.limit).toBe(1);
    expect(report.counts.MANUAL_REVIEW).toBe(1);
    expect(report.manual_review).toBe(1);
    expect(staleBefore).toBeTruthy();
  });
});
