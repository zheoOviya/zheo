import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus } from "@snakzap/types";

// ============================================
// EVT-B2B-PAY-B1 — reconciliation convergence transactional outbox wiring.
//
// Proves the five reconciliation tails (R1 GiftPaid, R2 PaymentSucceeded,
// R3 PaymentSucceeded recovery, R4 GiftRefunded observation, R5 local-refund
// convergence) enqueue their event on the SAME commit boundary as the local
// business mutation and the reconciliation-result marker, and no longer
// direct-emit.
//
// MEMORY_MODE = NON_DURABLE_TEST_PARITY: the passthrough port has no rollback
// and no concurrency guarantee, so this file proves enqueue/CAS/marker control
// flow and the removal of the direct emit path. Real rollback atomicity is
// proven against PostgreSQL by realPgB2bPayBReconciliation.ts.
// ============================================

import { onEvent } from "../lib/eventBus";
import type { EventOutboxRow } from "../repositories/eventOutboxRepository";
import { MemoryGiftRepository, type GiftDTO } from "../repositories/giftRepository";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";
import { MemoryOrderRepository, type OrderDTO } from "../repositories/orderRepository";
import { MemoryPaymentRepository, type PaymentDTO } from "../repositories/paymentRepository";
import { MemoryPaymentTransactionPort } from "../repositories/paymentAtomicityContracts";
import { reconcilePayment, type ReconciliationDeps, type ReconciliationGateway } from "./paymentReconciliation";
import type { RazorpayOrderEntity, RazorpayPaymentEntity, RazorpayRefundEntity } from "./razorpay";

const directEmits: string[] = [];
onEvent("GiftPaid", async (event) => {
  directEmits.push(event.event_name);
});
onEvent("PaymentSucceeded", async (event) => {
  directEmits.push(event.event_name);
});
onEvent("GiftRefunded", async (event) => {
  directEmits.push(event.event_name);
});

const rowsFor = (name: string): EventOutboxRow[] =>
  memoryEventOutbox._all().filter((row) => row.event_name === name);

class FakeGateway implements ReconciliationGateway {
  payments: RazorpayPaymentEntity[] = [];
  refunds: RazorpayRefundEntity[] = [];

  async fetchPayment(paymentId: string): Promise<RazorpayPaymentEntity | null> {
    return this.payments.find((p) => p.id === paymentId) ?? null;
  }
  async fetchOrder(): Promise<RazorpayOrderEntity | null> {
    return null;
  }
  async fetchPaymentsForOrder(razorpayOrderId: string): Promise<RazorpayPaymentEntity[]> {
    return this.payments.filter((p) => p.order_id === razorpayOrderId);
  }
  async fetchRefund(refundId: string): Promise<RazorpayRefundEntity | null> {
    return this.refunds.find((r) => r.id === refundId) ?? null;
  }
  async fetchRefundsForPayment(paymentId: string): Promise<RazorpayRefundEntity[]> {
    return this.refunds.filter((r) => r.payment_id === paymentId);
  }
}

function captured(id: string, orderId: string, amountPaise: number): RazorpayPaymentEntity {
  return {
    id,
    order_id: orderId,
    amount: amountPaise,
    currency: "INR",
    status: "captured",
    captured: true,
    method: "upi",
  };
}

function fullRefund(id: string, paymentId: string, amountPaise: number): RazorpayRefundEntity {
  return { id, payment_id: paymentId, amount: amountPaise, currency: "INR", status: "processed" };
}

function makeOrder(overrides: Partial<OrderDTO> = {}): OrderDTO {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    user_id: randomUUID(),
    restaurant_id: randomUUID(),
    items: [],
    total_amount: 50,
    status: "PAYMENT_PENDING" as OrderStatus,
    commission_rate: 0.08,
    commission_amount: 4,
    pickup_otp: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("EVT-B2B-PAY-B1 reconciliation transactional outbox", () => {
  let paymentRepo: MemoryPaymentRepository;
  let orderRepo: MemoryOrderRepository;
  let giftRepo: MemoryGiftRepository;
  let gateway: FakeGateway;

  beforeEach(() => {
    memoryEventOutbox._reset();
    directEmits.length = 0;
    paymentRepo = new MemoryPaymentRepository();
    orderRepo = new MemoryOrderRepository();
    giftRepo = new MemoryGiftRepository();
    gateway = new FakeGateway();
  });

  function deps(): ReconciliationDeps {
    return {
      paymentRepo,
      orderRepo,
      giftRepo,
      gateway,
      txPort: new MemoryPaymentTransactionPort(() => ({
        payments: paymentRepo,
        orders: orderRepo,
        gifts: giftRepo,
        outbox: memoryEventOutbox,
      })),
    };
  }

  async function makeGift(): Promise<GiftDTO> {
    return giftRepo.create({
      sender_id: randomUUID(),
      restaurant_id: randomUUID(),
      menu_item_id: randomUUID(),
      item_snapshot: {
        name: "PAY-B1 Gift",
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
      claim_code: "GIFTB1",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
  }

  // ---------------- R1: GiftPaid ----------------

  it("R1 PENDING gift capture -> gift ACTIVE + marker + one GiftPaid row, no direct emit", async () => {
    const gift = await makeGift();
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_payb1_r1",
      amount: 50,
    });
    gateway.payments.push(captured("pay_payb1_r1", "order_payb1_r1", 5000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect(result.emitted).toBe(true);
    expect((await giftRepo.getById(gift.id))!.status).toBe("ACTIVE");
    expect((await paymentRepo.getById(payment.id))!.reconciliation_status).toBe("CONVERGED");
    expect(rowsFor("GiftPaid")).toHaveLength(1);
    expect(directEmits).toHaveLength(0);
  });

  it("R1 CAS miss (gift already paid) -> NOOP and zero outbox rows", async () => {
    const gift = await makeGift();
    await giftRepo.markPaid(gift.id);
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_payb1_r1_miss",
      amount: 50,
    });
    gateway.payments.push(captured("pay_payb1_r1m", "order_payb1_r1_miss", 5000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("NOOP");
    expect(result.emitted).toBe(false);
    expect(rowsFor("GiftPaid")).toHaveLength(0);
  });

  // ---------------- R2: PaymentSucceeded (order PAYMENT_PENDING) ----------------

  it("R2 CAPTURED payment + PAYMENT_PENDING order -> CONFIRMED + marker + one row", async () => {
    const order = makeOrder({ status: "PAYMENT_PENDING" });
    orderRepo._seed(order);
    const payment = await paymentRepo.create({
      order_id: order.id,
      razorpay_order_id: "order_payb1_r2",
      amount: 50,
    });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_payb1_r2",
    });

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect((await paymentRepo.getById(payment.id))!.reconciliation_status).toBe("CONVERGED");
    expect(rowsFor("PaymentSucceeded")).toHaveLength(1);
    expect(directEmits).toHaveLength(0);
  });

  // ---------------- R3: PaymentSucceeded recovery ----------------

  it("R3 CAPTURED payment + PAYMENT_FAILED order recovery -> CONFIRMED + marker + one row", async () => {
    const order = makeOrder({ status: "PAYMENT_FAILED" });
    orderRepo._seed(order);
    const payment = await paymentRepo.create({
      order_id: order.id,
      razorpay_order_id: "order_payb1_r3",
      amount: 50,
    });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_payb1_r3",
    });
    gateway.payments.push(captured("pay_payb1_r3", "order_payb1_r3", 5000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    expect(rowsFor("PaymentSucceeded")).toHaveLength(1);
  });

  // ---------------- R4: GiftRefunded (gateway observation) ----------------

  it("R4 CAPTURED gift payment + full gateway refund -> gift/payment REFUNDED + one row", async () => {
    const gift = await makeGift();
    await giftRepo.markPaid(gift.id);
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_payb1_r4",
      amount: 50,
    });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: "pay_payb1_r4",
    });
    gateway.refunds.push(fullRefund("rfnd_payb1_r4", "pay_payb1_r4", 5000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await paymentRepo.getById(payment.id))!.status).toBe("REFUNDED");
    expect((await giftRepo.getById(gift.id))!.status).toBe("REFUNDED");
    expect((await paymentRepo.getById(payment.id))!.reconciliation_status).toBe("CONVERGED");
    expect(rowsFor("GiftRefunded")).toHaveLength(1);
    expect(directEmits).toHaveLength(0);
  });

  // ---------------- R5: local REFUNDED convergence ----------------

  it("R5 local REFUNDED gift + REFUNDING gift + full gateway refund -> gift converge + one row", async () => {
    const gift = await makeGift();
    await giftRepo.markPaid(gift.id);
    await giftRepo.markRefunding(gift.id, ["ACTIVE"]);
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_payb1_r5",
      amount: 50,
    });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "REFUNDED", {
      razorpay_payment_id: "pay_payb1_r5",
    });
    gateway.refunds.push(fullRefund("rfnd_payb1_r5", "pay_payb1_r5", 5000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await giftRepo.getById(gift.id))!.status).toBe("REFUNDED");
    expect((await paymentRepo.getById(payment.id))!.reconciliation_status).toBe("CONVERGED");
    expect(rowsFor("GiftRefunded")).toHaveLength(1);
  });

  it("R5 local REFUNDED order + CONFIRMED order + full gateway refund -> order REFUNDED, no gift row", async () => {
    const order = makeOrder({ status: "CONFIRMED" });
    orderRepo._seed(order);
    const payment = await paymentRepo.create({
      order_id: order.id,
      razorpay_order_id: "order_payb1_r5o",
      amount: 50,
    });
    await paymentRepo.compareAndSetStatus(payment.id, "CREATED", "REFUNDED", {
      razorpay_payment_id: "pay_payb1_r5o",
    });
    gateway.refunds.push(fullRefund("rfnd_payb1_r5o", "pay_payb1_r5o", 5000));

    const result = await reconcilePayment(payment.id, deps());

    expect(result.outcome).toBe("CONVERGED");
    expect((await orderRepo.getById(order.id))!.status).toBe("REFUNDED");
    expect((await paymentRepo.getById(payment.id))!.reconciliation_status).toBe("CONVERGED");
    expect(rowsFor("GiftRefunded")).toHaveLength(0);
  });
});
