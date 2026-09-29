import { publishStatusUpdate } from "../lib/websocket";
import { AppError } from "../middleware/envelope";
import type { OrderDTO, OrderRepository } from "../repositories/orderRepository";
import type { PaymentRepository } from "../repositories/paymentRepository";
import type { FulfillmentTransactionPort } from "../repositories/fulfillmentAtomicityContracts";
import { getFulfillmentTransactionPort } from "../repositories/drizzle/fulfillmentTransactionPort";
import { sharedOrderRepo, sharedPaymentRepo } from "../repositories/shared";
import { razorpayService } from "./razorpay";
import type { OrderStatus } from "@snakzap/types";

// ============================================
// Order cancellation + refund choke point (PAYMENT_CANCEL_REFUND-B1)
//
// ONE owner for paid-cancellation money movement. Both the vendor cancel route
// and the SUPER_ADMIN override route delegate here, so there is never a second
// refund implementation.
//
// Exactly-once full refund:
//   1. Read the order and its payment.
//   2. Validate the order is still cancellable (and matches an optional
//      optimistic `expectedFromStatus` precondition).
//   3. Atomically reserve the refund submission on a CAPTURED payment BEFORE any
//      gateway call (the reservation is permanent; it is never cleared).
//   4. CAS order current_status -> CANCELLED (releasing any bound gifts in the
//      same commit boundary).
//   5. Submit exactly one full refund to the gateway (only when THIS attempt won
//      the reservation; an ALREADY_RESERVED row is never re-submitted).
//   6. Record the local submission outcome.
//   7. The final REFUNDED state comes from the refund webhook / reconciliation
//      truth, never from a successful POST response.
//
// B1R concurrency rule: if THIS attempt owns the RESERVED reservation but a
// concurrent cancellation wins the order CAS, the owner STILL performs the one
// authorized refund POST. Only a caller that did not win the reservation (or
// owns nothing) returns idempotently. This prevents a paid order from ending in
// CANCELLED with a reservation that was never submitted.
//
// B1R identity rule: a CAPTURED payment with no gateway payment id is money we
// cannot safely move. Cancellation fails closed (MANUAL_REVIEW + error) before
// any order mutation; a missing gateway identity is never treated as
// "refund not required".
//
// Ambiguous gateway failures keep the reservation and mark MANUAL_REVIEW so a
// later retry can never fire a second refund POST.
// ============================================

/** Narrow gateway port. RazorpayService satisfies it; tests inject fakes. */
export interface OrderRefundGateway {
  refund(paymentId: string, amountInPaise: number): Promise<{ id: string; status: string }>;
}

/** How this cancellation attempt left the refund side. */
export type RefundDisposition =
  | "NOT_REQUIRED"
  | "SUBMITTED"
  | "ALREADY_RESERVED"
  | "SUBMISSION_FAILED";

export interface CancelOrderResult {
  order: OrderDTO;
  refund: RefundDisposition;
  /** True when the order was already terminal (no mutation, no refund POST). */
  idempotent: boolean;
}

/**
 * Statuses the product intentionally allows to be cancelled. This mirrors the
 * frozen policy: DRAFT / PAYMENT_PENDING / CONFIRMED / PREPARING only. It must
 * not be widened (ALMOST_READY and later stay non-cancellable).
 */
const CANCELLABLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "DRAFT",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PREPARING",
]);

/** Terminal states for which a repeated cancellation is a harmless no-op. */
const IDEMPOTENT_TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "CANCELLED",
  "REFUNDED",
]);

export class OrderRefundService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly gateway: OrderRefundGateway,
    private readonly txPort?: FulfillmentTransactionPort,
  ) {}

  private getTransactionPort(): FulfillmentTransactionPort {
    return this.txPort ?? getFulfillmentTransactionPort();
  }

  /**
   * Cancels an order through the single paid-cancellation choke point. Paid
   * online orders (CAPTURED payment) get exactly one full refund submission;
   * COD / unpaid / already-terminal orders get none.
   *
   * `expectedFromStatus` is the admin override's optimistic precondition: when
   * supplied, a current state that differs is a CONCURRENT_MODIFICATION failure
   * before any reservation or cancellation.
   */
  async cancelOrder(
    orderId: string,
    expectedFromStatus?: OrderStatus,
  ): Promise<CancelOrderResult> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }

    // Admin override carries an optimistic precondition. Enforce it here, before
    // any reservation, so the choke point can never cancel a state the caller
    // did not observe.
    if (expectedFromStatus !== undefined && order.status !== expectedFromStatus) {
      throw new AppError(
        "CONCURRENT_MODIFICATION",
        "Order status has changed; re-read and retry",
        409,
      );
    }

    if (IDEMPOTENT_TERMINAL_STATUSES.has(order.status)) {
      return {
        order,
        refund: await this.existingRefundDisposition(orderId),
        idempotent: true,
      };
    }

    if (!CANCELLABLE_STATUSES.has(order.status)) {
      throw new AppError(
        "INVALID_TRANSITION",
        `Order in ${order.status} cannot be cancelled`,
        400,
      );
    }

    const payment = await this.paymentRepo.getByOrderId(orderId);
    const isCaptured = payment !== null && payment.status === "CAPTURED";
    const gatewayPaymentId = payment?.razorpay_payment_id ?? null;

    // A CAPTURED payment with no gateway identity is money we cannot safely
    // move. Fail closed BEFORE any order mutation: flag for manual review and
    // refuse the cancellation rather than strand captured funds.
    if (isCaptured && gatewayPaymentId === null) {
      if (payment) {
        await this.paymentRepo.markRefundSubmissionResult(payment.id, {
          refund_initiation_status: "MANUAL_REVIEW",
          refund_initiation_reason: "CAPTURED_MISSING_PAYMENT_ID",
        });
      }
      throw new AppError(
        "PAYMENT_IDENTITY_MISSING",
        "Captured payment has no gateway payment id; cancellation blocked for manual review",
        409,
      );
    }

    const needsRefund = isCaptured && gatewayPaymentId !== null;

    // STEP 3: reserve BEFORE the gateway and BEFORE the order CAS. Only the
    // winner may ever submit; a duplicate caller (ALREADY_RESERVED) never fires
    // a second POST.
    let reserved = false;
    let alreadyReserved = false;
    if (needsRefund && payment) {
      const reservation = await this.paymentRepo.reserveRefundSubmission(payment.id, "CAPTURED");
      reserved = reservation.outcome === "RESERVED";
      alreadyReserved = reservation.outcome === "ALREADY_RESERVED";
    }

    // STEP 4: CAS order -> CANCELLED, releasing bound gifts at the same commit.
    const observedStatus = order.status;
    const updated = await this.getTransactionPort().runInTransaction(
      async ({ orders, gifts }) => {
        const cancelled = await orders.transitionStatus(orderId, observedStatus, "CANCELLED");
        if (!cancelled) return null;
        for (const line of order.items) {
          if (line.gift_id) await gifts.releaseFromOrder(line.gift_id, order.id);
        }
        return cancelled;
      },
    );

    let finalOrder: OrderDTO;
    if (!updated) {
      const current = await this.orderRepo.getById(orderId);
      if (current && current.status === "CANCELLED") {
        if (!reserved) {
          // A concurrent cancellation won the CAS and this attempt does not own
          // the submission reservation: harmless idempotent success, no POST.
          return {
            order: current,
            refund: alreadyReserved ? "ALREADY_RESERVED" : "NOT_REQUIRED",
            idempotent: true,
          };
        }
        // This attempt OWNS the permanent reservation. A concurrent cancellation
        // won the CAS, but the one authorized refund submission must still
        // happen; otherwise captured money would be silently stranded with a
        // reservation that was never submitted.
        finalOrder = current;
      } else {
        // The order moved to a non-cancellable state. If THIS attempt reserved a
        // refund, retain the reservation and flag it; never blind-submit.
        if (reserved && payment) {
          await this.paymentRepo.markRefundSubmissionResult(payment.id, {
            refund_initiation_status: "MANUAL_REVIEW",
            refund_initiation_reason: "CANCEL_CAS_LOST",
          });
        }
        throw new AppError("INVALID_TRANSITION", "Order is no longer cancellable", 400);
      }
    } else {
      finalOrder = updated;
    }

    // STEP 5 + 6: submit exactly once, then persist the local outcome.
    let refund: RefundDisposition = "NOT_REQUIRED";
    if (reserved && payment && payment.razorpay_payment_id) {
      const expectedPaise = Math.round(payment.amount * 100);
      try {
        const result = await this.gateway.refund(payment.razorpay_payment_id, expectedPaise);
        await this.paymentRepo.markRefundSubmissionResult(payment.id, {
          refund_provider_id: result.id,
          refund_initiation_status: "SUBMITTED",
          refund_initiation_reason: null,
        });
        refund = "SUBMITTED";
      } catch {
        // Ambiguous outcome (timeout / network / unknown). Keep the permanent
        // reservation and never auto-retry the POST.
        await this.paymentRepo.markRefundSubmissionResult(payment.id, {
          refund_initiation_status: "MANUAL_REVIEW",
          refund_initiation_reason: "AMBIGUOUS_REFUND_SUBMISSION",
        });
        refund = "SUBMISSION_FAILED";
      }
    } else if (alreadyReserved) {
      refund = "ALREADY_RESERVED";
    }

    await publishStatusUpdate({
      order_id: finalOrder.id,
      restaurant_id: finalOrder.restaurant_id,
      status: "CANCELLED",
    });

    return { order: finalOrder, refund, idempotent: false };
  }

  /**
   * Operator FULL_REFUND for a captured payment that is NOT being cancelled
   * (e.g. a MANUAL_REVIEW captured payment). It reuses the SAME exactly-once
   * reservation primitive as paid cancellation and mutates NO order state:
   *   1. Reserve the submission BEFORE any gateway call (permanent).
   *   2. Only the reservation winner POSTs; an ALREADY_RESERVED row never POSTs.
   *   3. Full amount only (no partial refund).
   *   4. Ambiguous failure keeps the reservation and flags MANUAL_REVIEW.
   *   5. Locally SUBMITTED only; the business status stays CAPTURED until the
   *      refund webhook / reconciliation proves the refund.
   */
  async submitFullRefundForCapturedPayment(paymentId: string): Promise<RefundDisposition> {
    const payment = await this.paymentRepo.getById(paymentId);
    if (!payment) {
      throw new AppError("PAYMENT_NOT_FOUND", "Payment not found", 404);
    }
    if (payment.status !== "CAPTURED") {
      throw new AppError(
        "PAYMENT_NOT_CAPTURED",
        `Cannot refund: payment is ${payment.status}, not CAPTURED`,
        409,
      );
    }
    if (!payment.razorpay_payment_id) {
      await this.paymentRepo.markRefundSubmissionResult(payment.id, {
        refund_initiation_status: "MANUAL_REVIEW",
        refund_initiation_reason: "CAPTURED_MISSING_PAYMENT_ID",
      });
      throw new AppError(
        "PAYMENT_IDENTITY_MISSING",
        "Captured payment has no gateway payment id; refund blocked for manual review",
        409,
      );
    }

    const reservation = await this.paymentRepo.reserveRefundSubmission(payment.id, "CAPTURED");
    if (reservation.outcome === "ALREADY_RESERVED") return "ALREADY_RESERVED";
    if (reservation.outcome !== "RESERVED") {
      throw new AppError(
        "REFUND_RESERVATION_UNAVAILABLE",
        "Payment is not in a refundable state",
        409,
      );
    }

    const expectedPaise = Math.round(payment.amount * 100);
    try {
      const result = await this.gateway.refund(payment.razorpay_payment_id, expectedPaise);
      await this.paymentRepo.markRefundSubmissionResult(payment.id, {
        refund_provider_id: result.id,
        refund_initiation_status: "SUBMITTED",
        refund_initiation_reason: null,
      });
      return "SUBMITTED";
    } catch {
      await this.paymentRepo.markRefundSubmissionResult(payment.id, {
        refund_initiation_status: "MANUAL_REVIEW",
        refund_initiation_reason: "AMBIGUOUS_REFUND_SUBMISSION",
      });
      return "SUBMISSION_FAILED";
    }
  }

  /** Refund disposition for an order that is already terminal. Read-only. */
  private async existingRefundDisposition(orderId: string): Promise<RefundDisposition> {
    const payment = await this.paymentRepo.getByOrderId(orderId);
    if (!payment) return "NOT_REQUIRED";
    if (payment.refund_initiation_status === "SUBMITTED") return "SUBMITTED";
    if (payment.refund_requested_at !== null) return "ALREADY_RESERVED";
    return "NOT_REQUIRED";
  }
}

/**
 * Production singleton: shared storage-mode-aware repos + the real gateway.
 * Both the vendor and admin routes use this instance so there is exactly one
 * cancellation/refund owner.
 */
export const sharedOrderRefundService = new OrderRefundService(
  sharedOrderRepo,
  sharedPaymentRepo,
  razorpayService,
);
