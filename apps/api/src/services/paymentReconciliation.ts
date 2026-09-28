import type { OrderStatus } from "@snakzap/types";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { logger } from "../lib/logger";
import type { GiftDTO, GiftRepository, GiftStatus } from "../repositories/giftRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import type {
  PaymentDTO,
  PaymentReconciliationStatus,
  PaymentRepository,
} from "../repositories/paymentRepository";
import { normalizeCandidateLimit } from "../repositories/paymentRepository";
import { sharedGiftRepo, sharedOrderRepo, sharedPaymentRepo } from "../repositories/shared";
import { isCaptureQuarantined, PAY4_CURRENCY } from "./paymentIntegrity";
import {
  isRazorpayReadError,
  razorpayService,
  type RazorpayOrderEntity,
  type RazorpayPaymentEntity,
  type RazorpayRefundEntity,
} from "./razorpay";

// ============================================
// PAYMENT_RECONCILIATION-B1 (PAY3-B)
// Gateway truth -> local convergence engine.
//
// This engine NEVER moves money: it reads gateway truth, converges local
// payment/order/gift state through atomic CAS, and flags anything ambiguous
// for manual review. Refunds are observed, never initiated.
//
// Scheduled sweep and the admin trigger both call reconcilePayment /
// runPaymentReconciliationBatch so there is exactly one code path.
// ============================================

/** Read-only gateway port. RazorpayService satisfies it; tests inject fakes. */
export interface ReconciliationGateway {
  fetchPayment(paymentId: string): Promise<RazorpayPaymentEntity | null>;
  fetchOrder(razorpayOrderId: string): Promise<RazorpayOrderEntity | null>;
  fetchPaymentsForOrder(razorpayOrderId: string): Promise<RazorpayPaymentEntity[]>;
  fetchRefund(refundId: string): Promise<RazorpayRefundEntity | null>;
  fetchRefundsForPayment(paymentId: string): Promise<RazorpayRefundEntity[]>;
}

export interface ReconciliationDeps {
  paymentRepo: PaymentRepository;
  orderRepo: OrderRepository;
  giftRepo?: GiftRepository;
  gateway: ReconciliationGateway;
}

export type ReconciliationOutcome =
  | "CONVERGED"
  | "NOOP"
  | "RETRY"
  | "MANUAL_REVIEW"
  | "ERROR";

export interface ReconcileResult {
  outcome: ReconciliationOutcome;
  reason: string;
  /** True only when a business success event was actually emitted. */
  emitted: boolean;
}

export interface ReconciliationBatchOptions {
  /** ISO timestamp; default is now - STALE_AGE. */
  staleBefore?: string;
  /** Include CAPTURED rows (order convergence decided here). Default true. */
  includeCaptured?: boolean;
  /** Max rows. Default BATCH_LIMIT (100). */
  limit?: number;
  now?: Date;
}

export interface ReconciliationBatchResult {
  scanned: number;
  converged: number;
  noop: number;
  retry: number;
  manual_review: number;
  errors: number;
}

export interface ReconciliationReport {
  candidates: number;
  limit: number;
  include_captured: boolean;
  stale_age_seconds: number;
  counts: Record<PaymentReconciliationStatus, number>;
  manual_review: number;
}

/** Frozen defaults for this stream (Gate 52683). */
export const PAYMENT_RECONCILIATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const PAYMENT_RECONCILIATION_STALE_AGE_MS = 10 * 60 * 1000;
export const PAYMENT_RECONCILIATION_BATCH_LIMIT = 100;

const CAPTURED_STATUSES = new Set(["captured"]);
const FAILED_STATUSES = new Set(["failed"]);
const REFUND_COMPLETE_STATUSES = new Set(["processed", "completed"]);
const ORDER_CONFIRMED_OR_LATER: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
  "PICKED_UP",
  "SETTLED",
]);

function isCapturedEntity(entity: RazorpayPaymentEntity): boolean {
  return entity.captured || CAPTURED_STATUSES.has(entity.status);
}

function toStoredStatus(
  outcome: ReconciliationOutcome,
): Exclude<PaymentReconciliationStatus, "NONE"> {
  return outcome === "NOOP" ? "CONVERGED" : outcome;
}

interface RecordArgs {
  outcome: ReconciliationOutcome;
  reason: string;
  gatewayStatus?: string | null;
  manualReview?: boolean;
  emitted?: boolean;
}

async function record(
  payment: PaymentDTO,
  deps: ReconciliationDeps,
  args: RecordArgs,
): Promise<ReconcileResult> {
  await deps.paymentRepo.markReconciliationResult(payment.id, {
    reconciliation_status: toStoredStatus(args.outcome),
    reconciliation_reason: args.reason,
    last_reconciled_at: new Date().toISOString(),
    ...(args.gatewayStatus !== undefined ? { gateway_status: args.gatewayStatus } : {}),
    manual_review: args.manualReview ?? false,
  });
  return { outcome: args.outcome, reason: args.reason, emitted: args.emitted ?? false };
}

async function casConflict(
  result:
    | { outcome: "NOOP_STATE_CHANGED"; payment: PaymentDTO }
    | { outcome: "NOT_FOUND" },
  deps: ReconciliationDeps,
): Promise<ReconcileResult> {
  if (result.outcome === "NOT_FOUND") {
    return { outcome: "ERROR", reason: "PAYMENT_NOT_FOUND", emitted: false };
  }
  return record(result.payment, deps, {
    outcome: "NOOP",
    reason: "CONCURRENT_STATE_CHANGE",
    gatewayStatus: result.payment.gateway_status,
  });
}

/**
 * Local convergence for a payment that is (or has just become) CAPTURED.
 * Order: atomic PAYMENT_PENDING -> CONFIRMED CAS (event only on success).
 * Gift: existing CAS paid-confirm (never a second gift state machine).
 */
async function convergeCapturedEntity(
  payment: PaymentDTO,
  deps: ReconciliationDeps,
  reason: string,
): Promise<ReconcileResult> {
  const gatewayStatus = payment.gateway_status;

  if (payment.gift_id) {
    if (!deps.giftRepo) {
      return record(payment, deps, {
        outcome: "MANUAL_REVIEW",
        reason: "GIFT_REPO_MISSING",
        manualReview: true,
      });
    }
    const gift = await deps.giftRepo.getById(payment.gift_id);
    if (!gift) {
      return record(payment, deps, {
        outcome: "MANUAL_REVIEW",
        reason: "GIFT_MISSING",
        manualReview: true,
      });
    }
    if (gift.status === "PENDING") {
      const paid = await deps.giftRepo.markPaid(gift.id);
      if (paid) {
        await emit(
          createEventEnvelope("GiftPaid", gift.id, {
            gift_id: gift.id,
            payment_id: payment.id,
            amount: payment.amount,
          }),
        );
        return record(payment, deps, {
          outcome: "CONVERGED",
          reason,
          gatewayStatus,
          emitted: true,
        });
      }
      const after = await deps.giftRepo.getById(gift.id);
      if (after && (after.status === "ACTIVE" || after.status === "CLAIMED")) {
        return record(payment, deps, {
          outcome: "NOOP",
          reason: "GIFT_ALREADY_PAID",
          gatewayStatus,
        });
      }
      return record(payment, deps, {
        outcome: "MANUAL_REVIEW",
        reason: "GIFT_CONVERGENCE_CONFLICT",
        gatewayStatus,
        manualReview: true,
      });
    }
    if (gift.status === "ACTIVE" || gift.status === "CLAIMED" || gift.status === "FULFILLED") {
      return record(payment, deps, {
        outcome: "NOOP",
        reason: "GIFT_ALREADY_PAID",
        gatewayStatus,
      });
    }
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: `GIFT_${gift.status}_CONFLICT`,
      gatewayStatus,
      manualReview: true,
    });
  }

  if (!payment.order_id) {
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "PAYMENT_WITHOUT_ENTITY",
      gatewayStatus,
      manualReview: true,
    });
  }
  const order = await deps.orderRepo.getById(payment.order_id);
  if (!order) {
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "ORDER_MISSING",
      gatewayStatus,
      manualReview: true,
    });
  }
  if (order.status === "PAYMENT_PENDING") {
    const transitioned = await deps.orderRepo.transitionStatus(
      order.id,
      "PAYMENT_PENDING",
      "CONFIRMED",
    );
    if (transitioned) {
      await emit(
        createEventEnvelope("PaymentSucceeded", order.id, {
          order_id: order.id,
          payment_id: payment.id,
          amount: payment.amount,
        }),
      );
      return record(payment, deps, { outcome: "CONVERGED", reason, gatewayStatus, emitted: true });
    }
    const after = await deps.orderRepo.getById(order.id);
    if (after && ORDER_CONFIRMED_OR_LATER.has(after.status)) {
      return record(payment, deps, {
        outcome: "NOOP",
        reason: "ORDER_ALREADY_CONFIRMED",
        gatewayStatus,
      });
    }
    if (after && after.status === "PAYMENT_PENDING") {
      return record(payment, deps, {
        outcome: "RETRY",
        reason: "ORDER_CAS_RETRY",
        gatewayStatus,
      });
    }
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "ORDER_CONVERGENCE_CONFLICT",
      gatewayStatus,
      manualReview: true,
    });
  }
  if (ORDER_CONFIRMED_OR_LATER.has(order.status)) {
    return record(payment, deps, {
      outcome: "NOOP",
      reason: "ORDER_ALREADY_CONFIRMED",
      gatewayStatus,
    });
  }
  return record(payment, deps, {
    outcome: "MANUAL_REVIEW",
    reason: `ORDER_${order.status}_CONFLICT`,
    gatewayStatus,
    manualReview: true,
  });
}

function findFullRefund(
  refunds: readonly RazorpayRefundEntity[],
  payment: PaymentDTO,
): RazorpayRefundEntity | null {
  const expectedPaise = Math.round(payment.amount * 100);
  return (
    refunds.find(
      (r) =>
        r.payment_id === payment.razorpay_payment_id &&
        REFUND_COMPLETE_STATUSES.has(r.status) &&
        r.amount === expectedPaise &&
        r.currency === PAY4_CURRENCY,
    ) ?? null
  );
}

const GIFT_REFUND_ENTRY_STATES: readonly GiftStatus[] = ["ACTIVE", "CLAIMED"];
const GIFT_REFUND_HOLD_STATES: ReadonlySet<GiftStatus> = new Set<GiftStatus>([
  "REFUNDING",
  "EXPIRED",
]);
const GIFT_REFUND_ALLOWED_STATES: ReadonlySet<GiftStatus> = new Set<GiftStatus>([
  ...GIFT_REFUND_ENTRY_STATES,
  ...GIFT_REFUND_HOLD_STATES,
  "REFUNDED",
]);

type GiftRefundConvergence = { status: "refunded"; gift: GiftDTO } | { status: "already" } | null;

/**
 * Observe-only gift refund convergence. It composes the EXISTING gift CAS
 * primitives instead of inventing a second gift state machine:
 *   ACTIVE/CLAIMED    -> markRefunding() -> REFUNDING -> markRefunded()
 *   REFUNDING/EXPIRED -> markRefunded()
 *
 * Returns "refunded" when the gift actually transitioned this call (caller
 * emits GiftRefunded), "already" when it was already REFUNDED, or null when the
 * gift is in a state reconciliation must not refund (caller flags review).
 */
async function convergeGiftRefund(
  deps: ReconciliationDeps,
  giftId: string,
): Promise<GiftRefundConvergence> {
  const giftRepo = deps.giftRepo;
  if (!giftRepo) return null;
  const gift = await giftRepo.getById(giftId);
  if (!gift) return null;
  if (gift.status === "REFUNDED") return { status: "already" };
  if (!GIFT_REFUND_ALLOWED_STATES.has(gift.status)) return null;

  if (GIFT_REFUND_ENTRY_STATES.includes(gift.status)) {
    const moved = await giftRepo.markRefunding(gift.id, [...GIFT_REFUND_ENTRY_STATES]);
    if (!moved) {
      const after = await giftRepo.getById(gift.id);
      return after && after.status === "REFUNDED" ? { status: "already" } : null;
    }
  }

  const refunded = await giftRepo.markRefunded(gift.id);
  if (refunded) return { status: "refunded", gift: refunded };
  const after = await giftRepo.getById(gift.id);
  return after && after.status === "REFUNDED" ? { status: "already" } : null;
}

/**
 * Refund observation (never initiation). Returns a result only when a full
 * gateway refund is proven and the local entity can be safely converged;
 * returns null when there is nothing to observe.
 */
async function observeGatewayRefund(
  payment: PaymentDTO,
  deps: ReconciliationDeps,
): Promise<ReconcileResult | null> {
  const gatewayPaymentId = payment.razorpay_payment_id;
  if (!gatewayPaymentId) return null;
  const refunds = await deps.gateway.fetchRefundsForPayment(gatewayPaymentId);
  const full = findFullRefund(refunds, payment);
  if (!full) return null;

  if (payment.gift_id) {
    if (!deps.giftRepo) {
      return record(payment, deps, {
        outcome: "MANUAL_REVIEW",
        reason: "GIFT_REPO_MISSING",
        manualReview: true,
      });
    }
    const gift = await deps.giftRepo.getById(payment.gift_id);
    if (!gift) {
      return record(payment, deps, {
        outcome: "MANUAL_REVIEW",
        reason: "GIFT_MISSING",
        manualReview: true,
      });
    }
    if (!GIFT_REFUND_ALLOWED_STATES.has(gift.status)) {
      return record(payment, deps, {
        outcome: "MANUAL_REVIEW",
        reason: `REFUND_GIFT_${gift.status}_CONFLICT`,
        gatewayStatus: full.status,
        manualReview: true,
      });
    }
    const cas = await deps.paymentRepo.compareAndSetStatus(payment.id, "CAPTURED", "REFUNDED", {
      gateway_status: full.status,
    });
    if (cas.outcome !== "UPDATED") return casConflict(cas, deps);
    const convergence = await convergeGiftRefund(deps, gift.id);
    if (!convergence) {
      return record(cas.payment, deps, {
        outcome: "MANUAL_REVIEW",
        reason: `REFUND_GIFT_${gift.status}_CONFLICT`,
        gatewayStatus: full.status,
        manualReview: true,
      });
    }
    let emitted = false;
    if (convergence.status === "refunded") {
      await emit(
        createEventEnvelope("GiftRefunded", gift.id, {
          gift_id: gift.id,
          sender_id: gift.sender_id,
          amount: payment.amount,
        }),
      );
      emitted = true;
    }
    return record(cas.payment, deps, {
      outcome: "CONVERGED",
      reason: "GATEWAY_FULL_REFUND_OBSERVED",
      gatewayStatus: full.status,
      emitted,
    });
  }

  if (!payment.order_id) return null;
  const order = await deps.orderRepo.getById(payment.order_id);
  if (!order) {
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "ORDER_MISSING",
      manualReview: true,
    });
  }
  if (order.status !== "CONFIRMED" && order.status !== "REFUNDED") {
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: `REFUND_ORDER_${order.status}_CONFLICT`,
      gatewayStatus: full.status,
      manualReview: true,
    });
  }
  const cas = await deps.paymentRepo.compareAndSetStatus(payment.id, "CAPTURED", "REFUNDED", {
    gateway_status: full.status,
  });
  if (cas.outcome !== "UPDATED") return casConflict(cas, deps);
  if (order.status === "CONFIRMED") {
    const moved = await deps.orderRepo.transitionStatus(order.id, "CONFIRMED", "REFUNDED");
    if (!moved) {
      const after = await deps.orderRepo.getById(order.id);
      if (!after || after.status !== "REFUNDED") {
        return record(cas.payment, deps, {
          outcome: "MANUAL_REVIEW",
          reason: "REFUND_ORDER_CONVERGENCE_CONFLICT",
          gatewayStatus: full.status,
          manualReview: true,
        });
      }
    }
  }
  return record(cas.payment, deps, {
    outcome: "CONVERGED",
    reason: "GATEWAY_FULL_REFUND_OBSERVED",
    gatewayStatus: full.status,
  });
}

async function reconcileCreated(
  payment: PaymentDTO,
  deps: ReconciliationDeps,
): Promise<ReconcileResult> {
  const payments = await deps.gateway.fetchPaymentsForOrder(payment.razorpay_order_id);
  const captured = payments.filter(isCapturedEntity);

  if (captured.length === 0) {
    const failed = payments.find((p) => FAILED_STATUSES.has(p.status));
    if (failed) {
      const cas = await deps.paymentRepo.compareAndSetStatus(payment.id, "CREATED", "FAILED", {
        gateway_status: failed.status,
        razorpay_payment_id: failed.id,
        ...(failed.method ? { method: failed.method } : {}),
      });
      if (cas.outcome !== "UPDATED") return casConflict(cas, deps);
      return record(cas.payment, deps, {
        outcome: "CONVERGED",
        reason: "GATEWAY_FAILED_CONFIRMED",
        gatewayStatus: failed.status,
      });
    }
    return record(payment, deps, { outcome: "RETRY", reason: "GATEWAY_PAYMENT_PENDING" });
  }

  const bound = captured.filter((p) => p.order_id === payment.razorpay_order_id);
  if (bound.length === 0) {
    // Section 3: a captured candidate that does not belong to this gateway
    // order is malformed truth; never promote it.
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "CAPTURE_ORDER_MISMATCH",
      gatewayStatus: captured[0]?.status,
      manualReview: true,
    });
  }

  const chosen = bound[0] as RazorpayPaymentEntity;
  const quarantined = await isCaptureQuarantined(
    payment,
    { currency: chosen.currency, amount: chosen.amount },
    { orderRepo: deps.orderRepo, giftRepo: deps.giftRepo },
  );
  if (quarantined) {
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "CAPTURE_INTEGRITY_VIOLATION",
      gatewayStatus: chosen.status,
      manualReview: true,
    });
  }

  const cas = await deps.paymentRepo.compareAndSetStatus(payment.id, "CREATED", "CAPTURED", {
    razorpay_payment_id: chosen.id,
    gateway_status: chosen.status,
    ...(chosen.method ? { method: chosen.method } : {}),
  });
  if (cas.outcome !== "UPDATED") return casConflict(cas, deps);
  return convergeCapturedEntity(cas.payment, deps, "CREATED_CAPTURE_RECOVERY");
}

async function reconcileCaptured(
  payment: PaymentDTO,
  deps: ReconciliationDeps,
): Promise<ReconcileResult> {
  const refundObservation = await observeGatewayRefund(payment, deps);
  if (refundObservation) return refundObservation;
  return convergeCapturedEntity(payment, deps, "CAPTURED_ORDER_RECOVERY");
}

async function reconcileFailed(
  payment: PaymentDTO,
  deps: ReconciliationDeps,
): Promise<ReconcileResult> {
  const payments = await deps.gateway.fetchPaymentsForOrder(payment.razorpay_order_id);
  const captured = payments.filter(isCapturedEntity);

  // Frozen policy (section 3): the exact capture that local truth already
  // recorded as a `payment.captured` webhook is never promoted (its id stays
  // quarantined). An ordinary `payment.failed` is NOT quarantined merely
  // because the same gateway payment id later appears captured — that id may
  // recover if it passes integrity. A valid DIFFERENT id is always a recovery
  // candidate, even when the local webhook was `payment.captured`.
  const isQuarantinedId = (candidate: RazorpayPaymentEntity): boolean =>
    candidate.id === payment.razorpay_payment_id &&
    payment.webhook_event === "payment.captured";

  let sawIntegrityViolation = false;
  for (const candidate of captured) {
    if (isQuarantinedId(candidate)) continue;
    if (candidate.order_id !== payment.razorpay_order_id) {
      sawIntegrityViolation = true;
      continue;
    }
    const quarantined = await isCaptureQuarantined(
      payment,
      { currency: candidate.currency, amount: candidate.amount },
      { orderRepo: deps.orderRepo, giftRepo: deps.giftRepo },
    );
    if (quarantined) {
      sawIntegrityViolation = true;
      continue;
    }
    const cas = await deps.paymentRepo.compareAndSetStatus(payment.id, "FAILED", "CAPTURED", {
      razorpay_payment_id: candidate.id,
      gateway_status: candidate.status,
      ...(candidate.method ? { method: candidate.method } : {}),
    });
    if (cas.outcome !== "UPDATED") return casConflict(cas, deps);
    return convergeCapturedEntity(cas.payment, deps, "FAILED_CAPTURE_RECOVERY");
  }

  const sameIdCaptured =
    payment.razorpay_payment_id !== null &&
    captured.some((p) => p.id === payment.razorpay_payment_id);
  if (sameIdCaptured && payment.webhook_event === "payment.captured") {
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "SAME_PAY4_QUARANTINED_PAYMENT",
      manualReview: true,
    });
  }

  if (sawIntegrityViolation) {
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "CAPTURE_INTEGRITY_VIOLATION",
      manualReview: true,
    });
  }
  const failed = payments.find((p) => FAILED_STATUSES.has(p.status));
  if (failed) {
    return record(payment, deps, {
      outcome: "NOOP",
      reason: "GATEWAY_FAILED_CONFIRMED",
      gatewayStatus: failed.status,
    });
  }
  return record(payment, deps, { outcome: "RETRY", reason: "GATEWAY_PAYMENT_PENDING" });
}

async function reconcileRefunded(
  payment: PaymentDTO,
  deps: ReconciliationDeps,
): Promise<ReconcileResult> {
  const gatewayPaymentId = payment.razorpay_payment_id;
  if (!gatewayPaymentId) {
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "LOCAL_REFUND_WITHOUT_GATEWAY_EVIDENCE",
      manualReview: true,
    });
  }
  const refunds = await deps.gateway.fetchRefundsForPayment(gatewayPaymentId);
  const full = findFullRefund(refunds, payment);
  if (!full) {
    // Local says REFUNDED but the gateway does not prove a completed full
    // refund: never downgrade, flag for review (RC15).
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "LOCAL_REFUND_WITHOUT_GATEWAY_EVIDENCE",
      manualReview: true,
    });
  }

  let orderOk = true;
  if (payment.order_id) {
    const order = await deps.orderRepo.getById(payment.order_id);
    if (order && order.status === "CONFIRMED") {
      const moved = await deps.orderRepo.transitionStatus(order.id, "CONFIRMED", "REFUNDED");
      if (!moved) {
        const after = await deps.orderRepo.getById(order.id);
        orderOk = !!after && after.status === "REFUNDED";
      }
    }
  }

  let giftConvergence: GiftRefundConvergence = { status: "already" };
  if (payment.gift_id) {
    giftConvergence = await convergeGiftRefund(deps, payment.gift_id);
  }
  if (!orderOk || giftConvergence === null) {
    return record(payment, deps, {
      outcome: "MANUAL_REVIEW",
      reason: "REFUND_LOCAL_CONVERGENCE_CONFLICT",
      gatewayStatus: full.status,
      manualReview: true,
    });
  }
  let emitted = false;
  if (giftConvergence.status === "refunded") {
    await emit(
      createEventEnvelope("GiftRefunded", giftConvergence.gift.id, {
        gift_id: giftConvergence.gift.id,
        sender_id: giftConvergence.gift.sender_id,
        amount: payment.amount,
      }),
    );
    emitted = true;
  }
  return record(payment, deps, {
    outcome: "CONVERGED",
    reason: "GATEWAY_FULL_REFUND_CONFIRMED",
    gatewayStatus: full.status,
    emitted,
  });
}

async function handleError(
  payment: PaymentDTO,
  deps: ReconciliationDeps,
  err: unknown,
): Promise<ReconcileResult> {
  if (isRazorpayReadError(err)) {
    return record(payment, deps, {
      outcome: "RETRY",
      reason: `GATEWAY_${err.failure.toUpperCase()}`,
    });
  }
  logger.error({
    message: "payment_reconciliation_failed",
    payment_id: payment.id,
    error: err instanceof Error ? err.message : String(err),
  });
  return record(payment, deps, {
    outcome: "ERROR",
    reason: "RECONCILIATION_ERROR",
  });
}

/**
 * One reconciliation pass for a single payment. Reads gateway truth and
 * converges local state via CAS. Never moves money.
 */
export async function reconcilePayment(
  paymentId: string,
  deps: ReconciliationDeps,
): Promise<ReconcileResult> {
  const payment = await deps.paymentRepo.getById(paymentId);
  if (!payment) {
    return { outcome: "ERROR", reason: "PAYMENT_NOT_FOUND", emitted: false };
  }
  try {
    switch (payment.status) {
      case "CREATED":
        return await reconcileCreated(payment, deps);
      case "CAPTURED":
        return await reconcileCaptured(payment, deps);
      case "FAILED":
        return await reconcileFailed(payment, deps);
      case "REFUNDED":
        return await reconcileRefunded(payment, deps);
      default:
        return await record(payment, deps, {
          outcome: "MANUAL_REVIEW",
          reason: `UNHANDLED_LOCAL_STATUS_${payment.status}`,
          manualReview: true,
        });
    }
  } catch (err) {
    return handleError(payment, deps, err);
  }
}

/**
 * One bounded batch. Enumerates local candidates through the repository's
 * bounded/DB-side query (no gateway call during enumeration) and reconciles
 * each. Used by both the scheduler and the admin trigger.
 */
export async function runPaymentReconciliationBatch(
  deps: ReconciliationDeps,
  options: ReconciliationBatchOptions = {},
): Promise<ReconciliationBatchResult> {
  const now = options.now ?? new Date();
  const staleBefore =
    options.staleBefore ?? new Date(now.getTime() - PAYMENT_RECONCILIATION_STALE_AGE_MS).toISOString();
  const candidates = await deps.paymentRepo.listReconciliationCandidates({
    staleBefore,
    includeCaptured: options.includeCaptured ?? true,
    limit: options.limit ?? PAYMENT_RECONCILIATION_BATCH_LIMIT,
  });

  const result: ReconciliationBatchResult = {
    scanned: candidates.length,
    converged: 0,
    noop: 0,
    retry: 0,
    manual_review: 0,
    errors: 0,
  };

  for (const candidate of candidates) {
    try {
      const outcome = await reconcilePayment(candidate.id, deps);
      switch (outcome.outcome) {
        case "CONVERGED":
          result.converged += 1;
          break;
        case "NOOP":
          result.noop += 1;
          break;
        case "RETRY":
          result.retry += 1;
          break;
        case "MANUAL_REVIEW":
          result.manual_review += 1;
          break;
        case "ERROR":
          result.errors += 1;
          break;
      }
    } catch (err) {
      result.errors += 1;
      logger.error({
        message: "payment_reconciliation_batch_item_failed",
        payment_id: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Bounded diagnostic report for admins. Counts only — never raw gateway
 * payloads or webhook bodies.
 */
export async function buildReconciliationReport(
  deps: ReconciliationDeps,
  options: { limit?: number; now?: Date } = {},
): Promise<ReconciliationReport> {
  const limit = normalizeCandidateLimit(options.limit ?? PAYMENT_RECONCILIATION_BATCH_LIMIT);
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - PAYMENT_RECONCILIATION_STALE_AGE_MS).toISOString();
  const candidates = await deps.paymentRepo.listReconciliationCandidates({
    staleBefore,
    includeCaptured: true,
    limit,
  });
  const counts: Record<PaymentReconciliationStatus, number> = {
    NONE: 0,
    CONVERGED: 0,
    RETRY: 0,
    MANUAL_REVIEW: 0,
    ERROR: 0,
  };
  for (const candidate of candidates) counts[candidate.reconciliation_status] += 1;
  return {
    candidates: candidates.length,
    limit,
    include_captured: true,
    stale_age_seconds: Math.round(PAYMENT_RECONCILIATION_STALE_AGE_MS / 1000),
    counts,
    manual_review: candidates.filter((c) => c.manual_review).length,
  };
}

/** Production dependency set: storage-mode-aware repos + the real gateway. */
export function defaultReconciliationDeps(): ReconciliationDeps {
  return {
    paymentRepo: sharedPaymentRepo,
    orderRepo: sharedOrderRepo,
    giftRepo: sharedGiftRepo,
    gateway: razorpayService,
  };
}

let timer: NodeJS.Timeout | null = null;

/** Boot wiring: run once, then on the interval. Unref'd so it never holds the process. */
export function startPaymentReconciliationSweep(
  intervalMs = PAYMENT_RECONCILIATION_SWEEP_INTERVAL_MS,
  deps: ReconciliationDeps = defaultReconciliationDeps(),
): void {
  if (timer) return;
  void runPaymentReconciliationBatch(deps).catch((err) => {
    logger.error({
      message: "payment_reconciliation_sweep_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  });
  timer = setInterval(() => {
    void runPaymentReconciliationBatch(deps).catch((err) => {
      logger.error({
        message: "payment_reconciliation_sweep_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);
  timer.unref();
}

export function stopPaymentReconciliationSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
