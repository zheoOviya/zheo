import type { OrderStatus } from "@snakzap/types";
import { createEventEnvelope } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import type { GiftRepository } from "../repositories/giftRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import type { PaymentRepository, PaymentDTO } from "../repositories/paymentRepository";
import type { PaymentTransactionPort } from "../repositories/paymentAtomicityContracts";
import { getPaymentTransactionPort } from "../repositories/drizzle/paymentTransactionPort";
import { sharedGiftRepo, sharedOrderRepo, sharedPaymentRepo } from "../repositories/shared";
import {
  validateCapturedAgainstGateway,
  type GatewayCaptureEntity,
} from "./paymentIntegrity";
import { sharedOrderRefundService, type RefundDisposition } from "./orderRefund";
import { razorpayService } from "./razorpay";

// ============================================
// PAY1 operator manual-review resolution surface (PAYMENT_CAPTURED_UNFULFILLED-B1)
//
// One SUPER_ADMIN-only concept with three actions. This is the ONLY operator
// path that may resolve a MANUAL_REVIEW captured payment; the automatic
// convergence path lives in paymentReconciliation.ts and is deliberately
// separate.
//
//   RECOVER_TO_CONFIRMED  explicit placement/recovery decision, PAY4-validated,
//                         CAS from the operator-observed from_status
//   FULL_REFUND           delegates to the shared exactly-once refund choke
//                         point (never a parallel refund implementation)
//   KEEP_MANUAL_REVIEW    no order/money/gateway mutation
//
// It never blind-writes an order and never fakes an approval: a DRAFT catering
// order (which requires a separate B2B approval contract) is rejected rather
// than being confirmed merely because the actor is SUPER_ADMIN.
// ============================================

export type ManualReviewAction =
  | "RECOVER_TO_CONFIRMED"
  | "FULL_REFUND"
  | "KEEP_MANUAL_REVIEW";

const MUTATING_ACTIONS: ReadonlySet<ManualReviewAction> = new Set<ManualReviewAction>([
  "RECOVER_TO_CONFIRMED",
  "FULL_REFUND",
]);

/**
 * Order states an operator RECOVER_TO_CONFIRMED may act on. CANCELLED / terminal
 * / already-fulfilling states are deliberately absent (PAY2 owns CANCELLED).
 */
const RECOVERABLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "DRAFT",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
]);

export interface ManualReviewGateway {
  fetchPayment(paymentId: string): Promise<GatewayCaptureEntity | null>;
}

export interface ManualReviewRefundService {
  submitFullRefundForCapturedPayment(paymentId: string): Promise<RefundDisposition>;
}

export interface PaymentManualReviewDeps {
  orderRepo: OrderRepository;
  paymentRepo: PaymentRepository;
  giftRepo?: GiftRepository;
  gateway: ManualReviewGateway;
  refundService: ManualReviewRefundService;
  /**
   * EVT-B2B-PAY-B2: optional injected transaction port. When provided (tests /
   * harnesses) the RECOVER_TO_CONFIRMED local tail runs through it; otherwise the
   * port is resolved lazily per call from the storage mode so route-module import
   * never locks in a backend.
   */
  txPort?: PaymentTransactionPort;
}

export interface ManualReviewInput {
  action: ManualReviewAction;
  /** Operator-observed order status; required for mutating actions. */
  from_status?: OrderStatus;
  reason?: string;
}

export interface ManualReviewResolution {
  action: ManualReviewAction;
  order_id: string;
  order_status: string;
  payment_status: string;
  from_status: string | null;
  refund?: RefundDisposition;
}

export class PaymentManualReviewService {
  constructor(private readonly deps: PaymentManualReviewDeps) {}

  async resolve(orderId: string, input: ManualReviewInput): Promise<ManualReviewResolution> {
    if (MUTATING_ACTIONS.has(input.action) && input.from_status === undefined) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${input.action} requires the operator-observed from_status`,
        400,
      );
    }
    switch (input.action) {
      case "RECOVER_TO_CONFIRMED":
        return this.recoverToConfirmed(orderId, input);
      case "FULL_REFUND":
        return this.fullRefund(orderId, input);
      case "KEEP_MANUAL_REVIEW":
        return this.keepManualReview(orderId, input);
      default:
        throw new AppError("VALIDATION_ERROR", "Unknown manual-review action", 400);
    }
  }

  private async loadOrderAndPayment(
    orderId: string,
  ): Promise<{
    order: NonNullable<Awaited<ReturnType<OrderRepository["getById"]>>>;
    payment: NonNullable<Awaited<ReturnType<PaymentRepository["getByOrderId"]>>>;
  }> {
    const order = await this.deps.orderRepo.getById(orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }
    const payment = await this.deps.paymentRepo.getByOrderId(orderId);
    if (!payment) {
      throw new AppError("PAYMENT_NOT_FOUND", "No payment found for this order", 404);
    }
    if (payment.order_id !== order.id) {
      throw new AppError(
        "PAYMENT_BINDING_MISMATCH",
        "Payment is not bound to this order",
        409,
      );
    }
    return { order, payment };
  }

  /**
   * PAY1-B1R eligibility guard. This resolver exists ONLY to decide the fate of a
   * payment that reconciliation already flagged for manual review. It must never
   * become a general-purpose recovery/refund authority for an ordinary captured
   * payment, and a call must never manufacture a manual-review state. Runs before
   * any gateway read, reservation, order CAS, event, or money movement.
   */
  private assertManualReviewEligible(payment: PaymentDTO): void {
    if (payment.status !== "CAPTURED") {
      throw new AppError(
        "PAYMENT_NOT_CAPTURED",
        `Cannot resolve: payment is ${payment.status}, not CAPTURED`,
        409,
      );
    }
    if (payment.manual_review !== true || payment.reconciliation_status !== "MANUAL_REVIEW") {
      throw new AppError(
        "PAYMENT_NOT_IN_MANUAL_REVIEW",
        "Payment is not an existing manual-review candidate; refusing to manufacture one",
        409,
      );
    }
  }

  /**
   * Proves the locally-CAPTURED payment against gateway truth using the single
   * frozen PAY4 predicate. Throws CAPTURE_INTEGRITY_VIOLATION on any failure so
   * no order/money mutation happens.
   */
  private async assertCaptureIntegrity(
    payment: Awaited<ReturnType<PaymentRepository["getByOrderId"]>>,
  ): Promise<void> {
    if (!payment || payment.status !== "CAPTURED") {
      throw new AppError(
        "PAYMENT_NOT_CAPTURED",
        `Cannot resolve: payment is ${payment?.status ?? "MISSING"}, not CAPTURED`,
        409,
      );
    }
    const entity = await this.fetchGatewayEntity(payment.razorpay_payment_id ?? "");
    const violation = await validateCapturedAgainstGateway(payment, entity, {
      orderRepo: this.deps.orderRepo,
      giftRepo: this.deps.giftRepo,
    });
    if (violation) {
      throw new AppError(
        "CAPTURE_INTEGRITY_VIOLATION",
        `Captured payment failed PAY4 revalidation: ${violation}`,
        409,
      );
    }
  }

  /**
   * Gateway read that fails closed. An unknown payment is `null` (a legitimate
   * gateway answer); an infrastructure error is converted to a rejection rather
   * than surfacing as an opaque 500, so no order/money mutation can happen.
   */
  private async fetchGatewayEntity(paymentId: string): Promise<GatewayCaptureEntity | null> {
    if (!paymentId) return null;
    try {
      return await this.deps.gateway.fetchPayment(paymentId);
    } catch {
      throw new AppError(
        "CAPTURE_INTEGRITY_UNVERIFIABLE",
        "Gateway revalidation failed; captured payment cannot be resolved right now",
        409,
      );
    }
  }

  /**
   * EVT-B2B-PAY-B2: resolve the transaction port for the RECOVER_TO_CONFIRMED
   * local tail. Gift methods are never reached from this path, so the narrowing
   * cast is safe; the Postgres branch ignores the arguments entirely and builds
   * repositories from one transaction handle.
   */
  private txPort(): PaymentTransactionPort {
    return (
      this.deps.txPort ??
      getPaymentTransactionPort(
        this.deps.paymentRepo,
        this.deps.orderRepo,
        this.deps.giftRepo as GiftRepository,
      )
    );
  }

  private async recoverToConfirmed(
    orderId: string,
    input: ManualReviewInput,
  ): Promise<ManualReviewResolution> {
    const { order, payment } = await this.loadOrderAndPayment(orderId);

    this.assertManualReviewEligible(payment);

    if (order.status !== input.from_status) {
      throw new AppError(
        "CONCURRENT_MODIFICATION",
        "Order status has changed; re-read and retry",
        409,
      );
    }
    if (!RECOVERABLE_STATUSES.has(order.status)) {
      throw new AppError(
        "INVALID_TRANSITION",
        `Order in ${order.status} cannot be recovered to CONFIRMED`,
        400,
      );
    }
    // A DRAFT order carries placement semantics. Catering requires a separate
    // B2B approval contract; being SUPER_ADMIN must never fake that approval.
    if (order.status === "DRAFT" && order.is_catering === true) {
      throw new AppError(
        "CATERING_APPROVAL_REQUIRED",
        "DRAFT catering recovery requires the B2B approval contract; generic PAY1 recovery is not permitted",
        409,
      );
    }

    // Gateway truth is proven BEFORE any transaction opens; a provider read must
    // never run inside a database transaction.
    await this.assertCaptureIntegrity(payment);

    // EVT-B2B-PAY-B2: the local tail — order CAS + PaymentSucceeded outbox row +
    // reconciliation-result marker — commits as one unit. A CAS loser commits
    // nothing; a failure rolls the whole tail back.
    const recovered = await this.txPort().runInTransaction(
      async ({ payments, orders, outbox }) => {
        const moved = await orders.transitionStatus(order.id, order.status, "CONFIRMED");
        if (!moved) return null;
        await outbox.enqueue(
          createEventEnvelope("PaymentSucceeded", order.id, {
            order_id: order.id,
            payment_id: payment.id,
            amount: payment.amount,
          }),
        );
        await payments.markReconciliationResult(payment.id, {
          reconciliation_status: "CONVERGED",
          reconciliation_reason: "MANUAL_REVIEW_RECOVER_TO_CONFIRMED",
          last_reconciled_at: new Date().toISOString(),
          manual_review: false,
        });
        return moved;
      },
    );
    if (!recovered) {
      throw new AppError(
        "CONCURRENT_MODIFICATION",
        "Order status has changed; re-read and retry",
        409,
      );
    }

    return {
      action: input.action,
      order_id: order.id,
      order_status: recovered.status,
      payment_status: payment.status,
      from_status: order.status,
    };
  }

  private async fullRefund(
    orderId: string,
    input: ManualReviewInput,
  ): Promise<ManualReviewResolution> {
    const { order, payment } = await this.loadOrderAndPayment(orderId);

    this.assertManualReviewEligible(payment);

    if (order.status !== input.from_status) {
      throw new AppError(
        "CONCURRENT_MODIFICATION",
        "Order status has changed; re-read and retry",
        409,
      );
    }

    await this.assertCaptureIntegrity(payment);

    // Delegate to the single shared exactly-once refund choke point. No order
    // mutation happens here.
    const refund = await this.deps.refundService.submitFullRefundForCapturedPayment(payment.id);

    return {
      action: input.action,
      order_id: order.id,
      order_status: order.status,
      payment_status: payment.status,
      from_status: order.status,
      refund,
    };
  }

  private async keepManualReview(
    orderId: string,
    input: ManualReviewInput,
  ): Promise<ManualReviewResolution> {
    const { order, payment } = await this.loadOrderAndPayment(orderId);

    // B1R: KEEP must prove the payment was ALREADY in manual review; it may only
    // refresh the reason/timestamp, never manufacture the state.
    this.assertManualReviewEligible(payment);

    await this.deps.paymentRepo.markReconciliationResult(payment.id, {
      reconciliation_status: "MANUAL_REVIEW",
      reconciliation_reason: input.reason ?? payment.reconciliation_reason ?? "OPERATOR_KEEP_MANUAL_REVIEW",
      last_reconciled_at: new Date().toISOString(),
      manual_review: true,
    });

    return {
      action: input.action,
      order_id: order.id,
      order_status: order.status,
      payment_status: payment.status,
      from_status: input.from_status ?? null,
    };
  }
}

/** Production singleton: shared repos + real gateway + shared refund owner. */
export const sharedPaymentManualReviewService = new PaymentManualReviewService({
  orderRepo: sharedOrderRepo,
  paymentRepo: sharedPaymentRepo,
  giftRepo: sharedGiftRepo,
  gateway: razorpayService,
  refundService: sharedOrderRefundService,
});
