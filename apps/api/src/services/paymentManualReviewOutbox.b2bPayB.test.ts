import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus } from "@snakzap/types";

// ============================================
// EVT-B2B-PAY-B2 M1 — manual-review RECOVER_TO_CONFIRMED transactional outbox.
//
// Proves the operator recovery tail (order transition -> CONFIRMED + one
// PaymentSucceeded outbox row + reconciliation-result marker) runs on ONE
// transaction port, replaces the former direct emit, and that every non-mutating
// or losing branch commits ZERO outbox rows. The gateway integrity read must
// stay OUTSIDE the transaction.
//
// MEMORY_MODE = NON_DURABLE_TEST_PARITY: the passthrough port has no rollback
// and no concurrency guarantee, so this file proves control flow, branch
// isolation and direct-emit removal. Real rollback atomicity and the
// gateway-before-transaction boundary are proven against PostgreSQL by
// apps/api/integration/realPgB2bPayBManualReview.ts.
// ============================================

import { onEvent } from "../lib/eventBus";
import type { EventOutboxRow } from "../repositories/eventOutboxRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";
import { MemoryOrderRepository, type OrderDTO } from "../repositories/orderRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import { MemoryPaymentRepository, type PaymentDTO } from "../repositories/paymentRepository";
import {
  MemoryPaymentTransactionPort,
  type PaymentTransactionPort,
  type PaymentTxRepos,
} from "../repositories/paymentAtomicityContracts";
import type { RazorpayPaymentEntity } from "./razorpay";
import type { RefundDisposition } from "./orderRefund";
import {
  PaymentManualReviewService,
  type ManualReviewGateway,
  type ManualReviewRefundService,
} from "./paymentManualReview";

const directEmits: string[] = [];
onEvent("PaymentSucceeded", async (event) => {
  directEmits.push(event.event_name);
});

const rowsFor = (name: string): EventOutboxRow[] =>
  memoryEventOutbox._all().filter((row) => row.event_name === name);

class ProbeGateway implements ManualReviewGateway {
  payments: RazorpayPaymentEntity[] = [];
  reads = 0;
  readsInTx = 0;

  async fetchPayment(paymentId: string): Promise<RazorpayPaymentEntity | null> {
    this.reads += 1;
    if (this.inTx) this.readsInTx += 1;
    return this.payments.find((p) => p.id === paymentId) ?? null;
  }

  inTx = false;
}

/** Wraps a port purely to observe whether the callback is executing. */
class TrackingTxPort implements PaymentTransactionPort {
  inTx = false;
  calls = 0;

  constructor(
    private readonly inner: PaymentTransactionPort,
    private readonly gateway: ProbeGateway,
  ) {}

  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T> {
    this.calls += 1;
    return this.inner.runInTransaction(async (repos) => {
      this.inTx = true;
      this.gateway.inTx = true;
      try {
        return await fn(repos);
      } finally {
        this.inTx = false;
        this.gateway.inTx = false;
      }
    });
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

/**
 * A read-only stale view: reports a fixed status for one order while every
 * write still lands on the real repo. Used to force a genuine CAS loser whose
 * pre-checks pass (stale read) but whose transaction CAS fails (real status).
 */
function staleStatusView(
  inner: OrderRepository,
  orderId: string,
  staleStatus: OrderStatus,
): OrderRepository {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "getById") {
        return async (id: string) => {
          const order = await target.getById(id);
          if (order && id === orderId) return { ...order, status: staleStatus };
          return order;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as OrderRepository;
}

describe("EVT-B2B-PAY-B2 M1 manual-review transactional outbox", () => {
  let orderRepo: MemoryOrderRepository;
  let paymentRepo: MemoryPaymentRepository;
  let giftRepo: MemoryGiftRepository;
  let gateway: ProbeGateway;
  let refunds: FakeRefundService;

  beforeEach(() => {
    memoryEventOutbox._reset();
    directEmits.length = 0;
    orderRepo = new MemoryOrderRepository();
    paymentRepo = new MemoryPaymentRepository();
    giftRepo = new MemoryGiftRepository();
    gateway = new ProbeGateway();
    refunds = new FakeRefundService();
  });

  function service(overrides: { orderRepo?: OrderRepository } = {}): PaymentManualReviewService {
    const txPort = new TrackingTxPort(
      new MemoryPaymentTransactionPort(() => ({
        payments: paymentRepo,
        orders: orderRepo,
        gifts: giftRepo,
        outbox: memoryEventOutbox,
      })),
      gateway,
    );
    return new PaymentManualReviewService({
      orderRepo: overrides.orderRepo ?? orderRepo,
      paymentRepo,
      giftRepo,
      gateway,
      refundService: refunds,
      txPort,
    });
  }

  async function seedManualReviewPayment(order: OrderDTO): Promise<PaymentDTO> {
    const created = await paymentRepo.create({
      order_id: order.id,
      razorpay_order_id: `order_${order.id.slice(0, 8)}`,
      amount: order.total_amount,
    });
    const paymentId = `pay_${order.id.slice(0, 8)}`;
    await paymentRepo.compareAndSetStatus(created.id, "CREATED", "CAPTURED", {
      razorpay_payment_id: paymentId,
    });
    await paymentRepo.markReconciliationResult(created.id, {
      reconciliation_status: "MANUAL_REVIEW",
      reconciliation_reason: "PAYMENT_FAILED_RECOVERY_INTEGRITY_FAILED",
      last_reconciled_at: new Date().toISOString(),
      manual_review: true,
    });
    gateway.payments.push(captured(paymentId, created.razorpay_order_id, order.total_amount * 100));
    return (await paymentRepo.getById(created.id))!;
  }

  // M1-B2B-1: the happy path commits the whole local tail and stops direct-emitting.
  it("M1 success -> order CONFIRMED + marker CONVERGED + one PaymentSucceeded row, no direct emit", async () => {
    const order = orderRepo._seed(makeOrder({ status: "PAYMENT_FAILED" }));
    const payment = await seedManualReviewPayment(order);

    const result = await service().resolve(order.id, {
      action: "RECOVER_TO_CONFIRMED",
      from_status: "PAYMENT_FAILED",
    });

    expect(result.order_status).toBe("CONFIRMED");
    expect((await orderRepo.getById(order.id))!.status).toBe("CONFIRMED");
    const stored = (await paymentRepo.getById(payment.id))!;
    expect(stored.reconciliation_status).toBe("CONVERGED");
    expect(stored.manual_review).toBe(false);
    expect(stored.status).toBe("CAPTURED");
    expect(rowsFor("PaymentSucceeded")).toHaveLength(1);
    expect(directEmits).toHaveLength(0);
  });

  // M1-B2B-2: the gateway integrity read runs before the transaction opens.
  it("M1 gateway read happens before the transaction (zero provider reads in tx)", async () => {
    const order = orderRepo._seed(makeOrder({ status: "PAYMENT_FAILED" }));
    await seedManualReviewPayment(order);

    await service().resolve(order.id, {
      action: "RECOVER_TO_CONFIRMED",
      from_status: "PAYMENT_FAILED",
    });

    expect(gateway.reads).toBeGreaterThanOrEqual(1);
    expect(gateway.readsInTx).toBe(0);
  });

  // M1-B2B-3: a genuine CAS loser commits nothing.
  it("M1 CAS loser -> CONCURRENT_MODIFICATION, zero rows, marker/order unchanged", async () => {
    const real = orderRepo._seed(makeOrder({ status: "CONFIRMED" }));
    const payment = await seedManualReviewPayment(real);
    const view = staleStatusView(orderRepo, real.id, "PAYMENT_FAILED");

    await expect(
      service({ orderRepo: view }).resolve(real.id, {
        action: "RECOVER_TO_CONFIRMED",
        from_status: "PAYMENT_FAILED",
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION", status: 409 });

    expect(rowsFor("PaymentSucceeded")).toHaveLength(0);
    expect(directEmits).toHaveLength(0);
    expect((await orderRepo.getById(real.id))!.status).toBe("CONFIRMED");
    const stored = (await paymentRepo.getById(payment.id))!;
    expect(stored.reconciliation_status).toBe("MANUAL_REVIEW");
    expect(stored.manual_review).toBe(true);
  });

  // M1-B2B-4: KEEP does not enqueue.
  it("M1 KEEP_MANUAL_REVIEW -> zero rows, no direct emit", async () => {
    const order = orderRepo._seed(makeOrder({ status: "PAYMENT_FAILED" }));
    await seedManualReviewPayment(order);

    await service().resolve(order.id, {
      action: "KEEP_MANUAL_REVIEW",
      reason: "OPERATOR_INVESTIGATING",
    });

    expect(rowsFor("PaymentSucceeded")).toHaveLength(0);
    expect(directEmits).toHaveLength(0);
  });

  // M1-B2B-5: FULL_REFUND does not enqueue or move the order.
  it("M1 FULL_REFUND -> zero rows, order unchanged, refund delegated once", async () => {
    const order = orderRepo._seed(makeOrder({ status: "PAYMENT_FAILED" }));
    await seedManualReviewPayment(order);

    const result = await service().resolve(order.id, {
      action: "FULL_REFUND",
      from_status: "PAYMENT_FAILED",
    });

    expect(result.refund).toBe("SUBMITTED");
    expect(refunds.calls).toHaveLength(1);
    expect(rowsFor("PaymentSucceeded")).toHaveLength(0);
    expect(directEmits).toHaveLength(0);
    expect((await orderRepo.getById(order.id))!.status).toBe("PAYMENT_FAILED");
  });
});
