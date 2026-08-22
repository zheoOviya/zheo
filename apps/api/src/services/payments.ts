import { randomUUID } from "node:crypto";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import type { GiftRepository } from "../repositories/giftRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import type { OrderDTO } from "../repositories/orderRepository";
import type {
  PaymentRepository,
  PaymentDTO,
  PaymentStatus,
} from "../repositories/paymentRepository";
import { PaymentTargetConflictError } from "../repositories/paymentRepository";
import { razorpayService, type RazorpayWebhookPayload, type RazorpayOrder } from "./razorpay";

// ============================================
// Payments context service (payments bounded context)
//
// Model A: ONE canonical payment intent (and ONE provider order) per order
// and per gift. The intent row is reserved in the DB BEFORE the gateway is
// touched; the gateway call happens outside the reservation and the intent is
// finalized with an idempotent CAS (`txn IS NULL`). A failed customer payment
// attempt NEVER mints a new provider order — retries reuse the same intent and
// the same `provider_transaction_id`.
//
// Concurrency contract (see Task 4 design):
//   - partial unique index wins the reservation race (loser gets 23505 and
//     returns the winner's intent, no duplicate gateway call);
//   - lease + CAS (`txn IS NULL`) bounds takeover of in-flight initiations to
//     one process at a time, reusing the intent's receipt (never a new one);
//   - ambiguous provider state is reconciled by exact receipt+amount+currency
//     (never a new order);
//   - webhook results only ever move status FORWARD on a monotonic ladder.
// ============================================

export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet" | "cod";

export interface PaymentInitiationResult {
  payment_method: PaymentMethod;
  /** Present once the intent is finalized (READY). Absent while IN_PROGRESS. */
  razorpay_order_id?: string;
  amount: number;
  currency: string;
  payment_id: string;
  payment_state: "READY" | "IN_PROGRESS";
  /** True while the intent can be retried (not yet finalized/settled). */
  retryable: boolean;
}

// In-process per-gift serialization for payment-order creation. This is only
// a LOCAL optimization; correctness is enforced by the DB unique indexes.
const giftPaymentLocks = new Map<string, Promise<unknown>>();

function withGiftPaymentLock<T>(giftId: string, fn: () => Promise<T>): Promise<T> {
  const prev = giftPaymentLocks.get(giftId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  giftPaymentLocks.set(giftId, run);
  return run.finally(() => {
    if (giftPaymentLocks.get(giftId) === run) giftPaymentLocks.delete(giftId);
  });
}

function buildReceipt(): string {
  return `pay_${randomUUID().replace(/-/g, "")}`;
}

export class PaymentService {
  private readonly instanceId = randomUUID();

  constructor(
    private readonly paymentRepo: PaymentRepository,
    private readonly orderRepo: OrderRepository,
    private readonly giftRepo?: GiftRepository,
  ) {}

  // ------------------------------------------------------------------
  // Online + COD order payment initiation
  // ------------------------------------------------------------------

  async createPaymentOrder(
    orderId: string,
    userId: string,
    method: PaymentMethod = "upi",
  ): Promise<PaymentInitiationResult> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }

    // Ownership boundary: only the order's owner may initiate payment or
    // confirm COD. Checked before ANY status/payment/gateway/event side
    // effect AND before the DRAFT check so a foreign caller cannot probe
    // another user's order state.
    if (order.user_id !== userId) {
      throw new AppError("FORBIDDEN", "Not your order", 403);
    }

    if (method === "cod" && order.status !== "DRAFT") {
      throw new AppError(
        "ORDER_NOT_DRAFT",
        `Cannot confirm COD: order is ${order.status}, not DRAFT`,
        400,
      );
    }

    if (method === "cod") {
      return this.initiateCod(order);
    }

    const existing = await this.paymentRepo.getByOrderId(order.id);
    if (existing && existing.razorpay_order_id !== null) {
      // Already READY/settled: idempotent return of the SAME intent (Model A)
      // even when the order has left DRAFT (PAYMENT_PENDING). Never touches the
      // gateway again, never mints a second provider order.
      if (existing.method === "cod") {
        throw new AppError(
          "PAYMENT_METHOD_CONFLICT",
          "Order is being paid via Cash on Delivery",
          409,
        );
      }
      // A settled order must not be handed a chargeable order id again — a
      // second gateway attempt on the same Razorpay order could double-charge.
      if (
        order.status !== "DRAFT" &&
        order.status !== "PAYMENT_PENDING" &&
        order.status !== "PAYMENT_FAILED"
      ) {
        throw new AppError(
          "ORDER_NOT_DRAFT",
          `Cannot create payment: order is ${order.status}, not DRAFT`,
          400,
        );
      }
      await this.ensureOrderPending(existing, order);
      return this.toResult(existing, method);
    }

    // No finalized intent yet: initiation is only allowed on a DRAFT order or
    // after a FAILED payment attempt (Model A retry reuses the same intent).
    if (order.status !== "DRAFT" && order.status !== "PAYMENT_FAILED") {
      throw new AppError(
        "ORDER_NOT_DRAFT",
        `Cannot create payment: order is ${order.status}, not DRAFT`,
        400,
      );
    }

    if (existing) {
      return this.resumeOrContinue(existing, order, method);
    }

    let intent: PaymentDTO;
    try {
      intent = await this.paymentRepo.createReservation({
        order_id: order.id,
        amount: order.total_amount,
        receipt: buildReceipt(),
        lease_owner: this.instanceId,
      });
    } catch (err) {
      if (err instanceof PaymentTargetConflictError) {
        const winner = await this.paymentRepo.getByOrderId(order.id);
        if (!winner) {
          throw new AppError(
            "PAYMENT_CREATE_CONFLICT",
            "Concurrent payment creation conflict; please retry",
            409,
          );
        }
        return this.resumeOrContinue(winner, order, method);
      }
      throw err;
    }

    return this.continueInitiation(intent, order, method);
  }

  /** Handles an already-reserved intent: settle-fast, take over, or 202. */
  private async resumeOrContinue(
    existing: PaymentDTO,
    order: OrderDTO,
    method: PaymentMethod,
  ): Promise<PaymentInitiationResult> {
    // The order is claimed by COD — an online intent cannot be layered on top.
    if (existing.method === "cod") {
      throw new AppError(
        "PAYMENT_METHOD_CONFLICT",
        "Order is being paid via Cash on Delivery",
        409,
      );
    }
    if (existing.razorpay_order_id !== null) {
      await this.ensureOrderPending(existing, order);
      return this.toResult(existing, method);
    }
    const lease = await this.paymentRepo.acquireLease(existing.id, this.instanceId);
    if (!lease.acquired) {
      if (lease.reason === "settled") {
        await this.ensureOrderPending(lease.payment as PaymentDTO, order);
        return this.toResult(lease.payment as PaymentDTO, method);
      }
      // Another process is mid-initiation; the caller retries.
      return this.toResult(existing, method, "IN_PROGRESS");
    }
    return this.continueInitiation(lease.payment, order, method);
  }

  /**
   * Gateway step + finalize for an acquired intent. Reconciles by exact
   * receipt (reuses an existing provider order; never mints a duplicate) and
   * finalizes via `txn IS NULL` CAS.
   */
  private async continueInitiation(
    intent: PaymentDTO,
    order: OrderDTO,
    method: PaymentMethod,
  ): Promise<PaymentInitiationResult> {
    const amountPaise = Math.round(order.total_amount * 100);
    let rpOrder: RazorpayOrder;
    try {
      rpOrder = await this.reconcileOrCreateOrder(intent.receipt, amountPaise);
    } catch (err) {
      // Gateway is unreachable or ambiguous: mark the intent terminal so a
      // later request can take it over and retry with the SAME receipt.
      await this.paymentRepo.markFailedInitiation(intent.id, (err as Error).message);
      throw err;
    }

    let payment = await this.paymentRepo.finalizeInitiation(intent.id, rpOrder.id);
    if (!payment) {
      // Lost the finalize race to a concurrent takeover/lease holder.
      payment = (await this.paymentRepo.getById(intent.id)) ?? intent;
    }
    // The intent was taken over and finalized as COD while we were inside the
    // gateway call: never surface the internal COD marker as an online checkout
    // id — that would hand the frontend a garbage `cod_*` order id.
    if (payment.method === "cod") {
      throw new AppError(
        "PAYMENT_METHOD_CONFLICT",
        "Order is being paid via Cash on Delivery",
        409,
      );
    }
    await this.ensureOrderPending(payment, order);
    return this.toResult(payment, method);
  }

  /**
   * DRAFT -> PAYMENT_PENDING (CAS); a retry after a FAILED payment moves
   * PAYMENT_FAILED -> PAYMENT_PENDING (CAS). Only the first (winning) call
   * transitions the order; concurrent create requests see it already moved
   * and skip.
   */
  private async ensureOrderPending(
    payment: PaymentDTO,
    order: OrderDTO,
  ): Promise<void> {
    const txn = payment.razorpay_order_id;
    if (!txn) return;
    const moved = await this.orderRepo.updateStatusIf(order.id, "DRAFT", "PAYMENT_PENDING");
    if (!moved) {
      await this.orderRepo.updateStatusIf(order.id, "PAYMENT_FAILED", "PAYMENT_PENDING");
    }
  }

  private async initiateCod(order: OrderDTO): Promise<PaymentInitiationResult> {
    const confirm = async (payment: PaymentDTO): Promise<PaymentInitiationResult> => {
      // A COD confirm may only ever apply to a genuine COD intent. This guard
      // covers every path into confirm (including the 23505-loser re-read and
      // the lease-takeover fall-through): if the intent was finalized by an
      // ONLINE initiation in the meantime, the confirm must fail, never surface
      // a fake COD result layered on top of an online payment.
      if (payment.method !== "cod") {
        throw new AppError(
          "PAYMENT_METHOD_CONFLICT",
          "Order is being paid online",
          409,
        );
      }
      // Cash is collected at the counter on pickup, so the order goes straight
      // to CONFIRMED. CAS on DRAFT: only the winner transitions/emits, so a
      // duplicate COD request can never double-confirm or double-emit.
      const moved = await this.orderRepo.updateStatusIf(order.id, "DRAFT", "CONFIRMED");
      if (moved) {
        await emit(
          createEventEnvelope("CashOnPickupSelected", order.id, {
            order_id: order.id,
            payment_id: payment.id,
            amount: order.total_amount,
          }),
        );
      }
      return this.toResult(payment, "cod");
    };
    const codTxn = (payment: PaymentDTO): string => `cod_${payment.id.slice(0, 8)}`;

    let intent = await this.paymentRepo.getByOrderId(order.id);
    if (intent && intent.razorpay_order_id !== null) {
      // Finalized intent: only COD may be confirmed.
      if (intent.method !== "cod") {
        throw new AppError(
          "PAYMENT_METHOD_CONFLICT",
          "Order already has an online payment intent",
          409,
        );
      }
      return confirm(intent);
    }
    if (intent && intent.razorpay_order_id === null) {
      const lease = await this.paymentRepo.acquireLease(intent.id, this.instanceId);
      if (lease.acquired) {
        // Takeover is only safe for a genuinely COD-owned intent or a crashed
        // online initiation (FAILED_INITIATION). An ACTIVE online initiation
        // (method null, still INITIATING) must NEVER be converted to COD even
        // if its lease expired: the online process may still be mid-gateway
        // and would return a false double-success on the same intent.
        if (intent.method !== "cod" && intent.status !== "FAILED_INITIATION") {
          throw new AppError("PAYMENT_METHOD_CONFLICT", "Order is being paid online", 409);
        }
        intent = lease.payment;
      } else if (lease.reason === "settled") {
        intent = lease.payment as PaymentDTO;
      } else if (intent.method !== "cod" && intent.status !== "FAILED_INITIATION") {
        // Actively being initiated online by another process.
        throw new AppError("PAYMENT_METHOD_CONFLICT", "Order is being paid online", 409);
      } else {
        return this.toResult(intent, "cod", "IN_PROGRESS");
      }
    }
    if (!intent || intent.razorpay_order_id === null) {
      if (!intent) {
        try {
          intent = await this.paymentRepo.createReservation({
            order_id: order.id,
            amount: order.total_amount,
            method: "cod",
            receipt: `cod_${randomUUID().slice(0, 8)}`,
            lease_owner: this.instanceId,
          });
        } catch (err) {
          if (err instanceof PaymentTargetConflictError) {
            const winner = await this.paymentRepo.getByOrderId(order.id);
            if (!winner) {
              throw new AppError(
                "PAYMENT_CREATE_CONFLICT",
                "Concurrent payment creation conflict; please retry",
                409,
              );
            }
            if (winner.razorpay_order_id === null && winner.method !== "cod" && winner.status !== "FAILED_INITIATION") {
              // The winner is an active ONLINE initiation; COD must not touch it.
              throw new AppError("PAYMENT_METHOD_CONFLICT", "Order is being paid online", 409);
            }
            if (winner.razorpay_order_id !== null) return confirm(winner);
            intent = winner;
          } else {
            throw err;
          }
        }
      }
      if (intent && intent.razorpay_order_id === null) {
        const finalized = await this.paymentRepo.finalizeInitiation(
          intent.id,
          codTxn(intent),
          "cod",
        );
        intent = finalized ?? ((await this.paymentRepo.getById(intent.id)) ?? intent);
      }
    }
    if (!intent) {
      throw new AppError(
        "PAYMENT_CREATE_CONFLICT",
        "Concurrent payment creation conflict; please retry",
        409,
      );
    }
    return confirm(intent);
  }

  // ------------------------------------------------------------------
  // Gift payment initiation
  // ------------------------------------------------------------------

  async createGiftPayment(
    giftId: string,
    userId: string,
  ): Promise<{
    gift_id: string;
    razorpay_order_id?: string;
    amount: number;
    currency: string;
    payment_id: string;
    payment_state: "READY" | "IN_PROGRESS";
    retryable: boolean;
  }> {
    return withGiftPaymentLock(giftId, async () => {
      return this.createGiftPaymentUnlocked(giftId, userId);
    });
  }

  private async createGiftPaymentUnlocked(
    giftId: string,
    userId: string,
  ): Promise<{
    gift_id: string;
    razorpay_order_id?: string;
    amount: number;
    currency: string;
    payment_id: string;
    payment_state: "READY" | "IN_PROGRESS";
    retryable: boolean;
  }> {
    if (!this.giftRepo) {
      throw new AppError("GIFT_REPO_MISSING", "Gift repository is not configured", 500);
    }
    const gift = await this.giftRepo.getById(giftId);
    if (!gift) {
      throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    }
    // Task 3G: only the sender may initiate (or retry) the gift payment.
    if (gift.sender_id !== userId) {
      throw new AppError("FORBIDDEN", "Not your gift", 403);
    }
    if (gift.status !== "PENDING" && gift.status !== "ACTIVE") {
      throw new AppError(
        "GIFT_NOT_PAYABLE",
        `Gift is ${gift.status}, not payable`,
        400,
      );
    }

    const existing = await this.paymentRepo.getByGiftId(giftId);
    if (existing) {
      if (existing.razorpay_order_id !== null) {
        if (existing.status === "CAPTURED" || existing.status === "REFUNDED") {
          throw new AppError(
            "GIFT_ALREADY_PAID",
            `Gift payment is already ${existing.status}`,
            400,
          );
        }
        return this.giftResult(existing);
      }
      // In-flight intent: take over if possible, else 202 IN_PROGRESS.
      const lease = await this.paymentRepo.acquireLease(existing.id, this.instanceId);
      if (!lease.acquired) {
        if (lease.reason === "settled") {
          return this.giftResult(lease.payment as PaymentDTO);
        }
        return this.giftResult(existing, "IN_PROGRESS");
      }
      return this.continueGiftInitiation(lease.payment, giftId, gift.price_paid);
    }

    let intent: PaymentDTO;
    try {
      intent = await this.paymentRepo.createReservation({
        gift_id: giftId,
        amount: gift.price_paid,
        receipt: buildReceipt(),
        lease_owner: this.instanceId,
      });
    } catch (err) {
      if (err instanceof PaymentTargetConflictError) {
        const winner = await this.paymentRepo.getByGiftId(giftId);
        if (!winner) {
          throw new AppError(
            "PAYMENT_CREATE_CONFLICT",
            "Concurrent payment creation conflict; please retry",
            409,
          );
        }
        if (winner.razorpay_order_id !== null) return this.giftResult(winner);
        return this.giftResult(winner, "IN_PROGRESS");
      }
      throw err;
    }
    return this.continueGiftInitiation(intent, giftId, gift.price_paid);
  }

  private async continueGiftInitiation(
    intent: PaymentDTO,
    giftId: string,
    amount: number,
  ): Promise<{
    gift_id: string;
    razorpay_order_id?: string;
    amount: number;
    currency: string;
    payment_id: string;
    payment_state: "READY" | "IN_PROGRESS";
    retryable: boolean;
  }> {
    const amountPaise = Math.round(amount * 100);
    let rpOrder: RazorpayOrder;
    try {
      rpOrder = await this.reconcileOrCreateOrder(intent.receipt, amountPaise);
    } catch (err) {
      await this.paymentRepo.markFailedInitiation(intent.id, (err as Error).message);
      throw err;
    }
    const payment = (await this.paymentRepo.finalizeInitiation(intent.id, rpOrder.id)) ?? intent;
    void giftId;
    return this.giftResult(payment);
  }

  private giftResult(
    payment: PaymentDTO,
    state: "READY" | "IN_PROGRESS" = payment.razorpay_order_id ? "READY" : "IN_PROGRESS",
  ): {
    gift_id: string;
    razorpay_order_id?: string;
    amount: number;
    currency: string;
    payment_id: string;
    payment_state: "READY" | "IN_PROGRESS";
    retryable: boolean;
  } {
    return {
      gift_id: payment.gift_id as string,
      razorpay_order_id: payment.razorpay_order_id ?? undefined,
      amount: payment.amount,
      currency: payment.currency,
      payment_id: payment.id,
      payment_state: state,
      retryable: payment.razorpay_order_id === null,
    };
  }

  // ------------------------------------------------------------------
  // Provider order reconcile (never mint a duplicate)
  // ------------------------------------------------------------------

  /**
   * Returns the provider order for `receipt`, creating one only when none
   * exists. If creation races with another process (or a crash left an order
   * behind), the duplicate-receipt rejection on create is resolved by
   * re-fetching — never by minting a new order.
   */
  private async reconcileOrCreateOrder(
    receipt: string,
    amountInPaise: number,
  ): Promise<RazorpayOrder> {
    const existing = await razorpayService.fetchOrdersByReceipt(receipt);
    if (existing) {
      if (existing.amount !== amountInPaise || existing.currency !== "INR") {
        throw new AppError(
          "AMBIGUOUS_RECEIPT",
          "Provider order exists with mismatched amount/currency; refusing to create a new one",
          409,
        );
      }
      return existing;
    }
    try {
      return await razorpayService.createOrder(amountInPaise, receipt);
    } catch (err) {
      const maybe = await razorpayService.fetchOrdersByReceipt(receipt);
      if (maybe && maybe.amount === amountInPaise && maybe.currency === "INR") {
        return maybe;
      }
      throw err;
    }
  }

  private toResult(
    payment: PaymentDTO,
    method: PaymentMethod,
    state: "READY" | "IN_PROGRESS" = payment.razorpay_order_id ? "READY" : "IN_PROGRESS",
  ): PaymentInitiationResult {
    return {
      payment_method: method,
      // COD carries an internal marker, not a gateway order — never surfaced.
      razorpay_order_id:
        method === "cod" ? undefined : (payment.razorpay_order_id ?? undefined),
      amount: payment.amount,
      currency: payment.currency,
      payment_id: payment.id,
      payment_state: state,
      retryable: payment.razorpay_order_id === null,
    };
  }

  // ------------------------------------------------------------------
  // Webhook processing (monotonic, idempotent)
  // ------------------------------------------------------------------

  async processWebhook(
    rawBody: string,
    signatureHeader: string,
  ): Promise<{
    processed: boolean;
    idempotent: boolean;
    orderStatus?: string;
    giftStatus?: string;
  }> {
    if (!razorpayService.verifyWebhookSignature(rawBody, signatureHeader)) {
      throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Webhook signature verification failed", 401);
    }

    const payload: RazorpayWebhookPayload = JSON.parse(rawBody);
    if (payload.event === "refund.processed" || payload.event === "refund.cleared") {
      return this.processRefundWebhook(payload);
    }
    const entity = payload.payload?.payment?.entity;
    if (!entity?.id) {
      throw new AppError(
        "INVALID_WEBHOOK",
        "Malformed webhook payload: missing payment entity",
        400,
      );
    }

    // IDEMPOTENCY: this razorpay_payment_id was already applied.
    const existing = await this.paymentRepo.findByRazorpayPaymentId(entity.id);
    if (existing) {
      return { processed: false, idempotent: true };
    }

    // Resolve the intent by the provider order id.
    const payment = await this.paymentRepo.findByRazorpayOrderId(entity.order_id);
    if (!payment) {
      throw new AppError(
        "PAYMENT_NOT_FOUND",
        "No payment record found for this Razorpay order",
        404,
      );
    }
    // COD never receives gateway webhooks; ignore any strays.
    if (payment.method === "cod") {
      return { processed: false, idempotent: true };
    }

    // Classify by the REAL gateway status, not a binary captured/not-captured:
    // `payment.authorized` is a normal mid-flow event (NOT a failure) and must
    // not fail the order; `payment.pending` means the customer is still on the
    // gateway and must not touch the order at all. Only a genuine
    // `payment.failed` moves the order to PAYMENT_FAILED.
    const entityStatus = entity.status ?? "";
    const isCaptured = entity.captured || entityStatus === "captured";
    let targetStatus: PaymentStatus;
    if (isCaptured) {
      targetStatus = "CAPTURED";
    } else if (entityStatus === "authorized") {
      targetStatus = "AUTHORIZED";
    } else if (entityStatus === "failed") {
      targetStatus = "FAILED";
    } else {
      // pending / unknown: no state side effect (monotonic ladder refuses it).
      return { processed: false, idempotent: true };
    }

    const updated = await this.paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: entity.id,
      status: targetStatus,
      method: entity.method ?? "unknown",
      webhook_event: payload.event,
      webhook_raw: payload,
    });

    if (!updated.applied) {
      // Stale/out-of-order event (e.g. a late payment.failed after the intent
      // was already captured/refunded): honor monotonicity, no side effects.
      return { processed: false, idempotent: true };
    }
    const current = updated.payment as PaymentDTO;

    if (current.gift_id) {
      if (isCaptured && this.giftRepo) {
        // markPaid is CAS (PENDING -> ACTIVE): a concurrent cancel can never
        // be clobbered into ACTIVE; if it fails the gift was cancelled and the
        // capture will need a manual refund instead.
        const gift = await this.giftRepo.markPaid(current.gift_id);
        if (gift) {
          await emit(
            createEventEnvelope("GiftPaid", current.gift_id, {
              gift_id: current.gift_id,
              payment_id: current.id,
              amount: current.amount,
            }),
          );
        }
        return { processed: true, idempotent: false, giftStatus: gift?.status ?? "PENDING" };
      }
      return { processed: true, idempotent: false, giftStatus: "PENDING" };
    }

    if (!current.order_id) {
      throw new AppError(
        "PAYMENT_MISSING_ORDER",
        "Payment record has no order_id to update",
        500,
      );
    }

    if (isCaptured) {
      // CAS to CONFIRMED. A captured payment is terminal on the ladder, so a
      // prior (stale/out-of-order) FAILED is never a reason to keep the order
      // stranded — retry the transition from PAYMENT_FAILED as well.
      let moved = await this.orderRepo.updateStatusIf(
        current.order_id,
        "PAYMENT_PENDING",
        "CONFIRMED",
      );
      if (!moved) {
        moved = await this.orderRepo.updateStatusIf(
          current.order_id,
          "PAYMENT_FAILED",
          "CONFIRMED",
        );
      }
      if (moved) {
        await emit(
          createEventEnvelope("PaymentSucceeded", current.order_id, {
            order_id: current.order_id,
            payment_id: current.id,
            amount: current.amount,
          }),
        );
      }
      return { processed: true, idempotent: false, orderStatus: "CONFIRMED" };
    }

    if (targetStatus === "AUTHORIZED") {
      // Payment is authorized but not yet captured; the order stays
      // PAYMENT_PENDING until the capture webhook confirms it.
      return { processed: true, idempotent: false, orderStatus: "PAYMENT_PENDING" };
    }

    const moved = await this.orderRepo.updateStatusIf(
      current.order_id,
      "PAYMENT_PENDING",
      "PAYMENT_FAILED",
    );
    if (moved) {
      await emit(
        createEventEnvelope("PaymentFailed", current.order_id, {
          order_id: current.order_id,
          payment_id: current.id,
          reason: entity.description ?? "Payment failed",
        }),
      );
    }
    return { processed: true, idempotent: false, orderStatus: "PAYMENT_FAILED" };
  }

  private async processRefundWebhook(
    payload: { event: string; payload: { payment?: unknown; refund?: { entity?: { payment_id?: string; amount?: number } } } },
  ): Promise<{
    processed: boolean;
    idempotent: boolean;
    orderStatus?: string;
    giftStatus?: string;
  }> {
    const refundEntity = payload.payload?.refund?.entity;
    const razorpayPaymentId = refundEntity?.payment_id;
    if (!razorpayPaymentId) {
      throw new AppError("INVALID_WEBHOOK", "Malformed refund webhook: missing payment_id", 400);
    }

    const payment = await this.paymentRepo.findByRazorpayPaymentId(razorpayPaymentId);
    if (!payment) {
      throw new AppError("PAYMENT_NOT_FOUND", "No payment record found for this refund", 404);
    }
    if (payment.status === "REFUNDED") {
      return { processed: false, idempotent: true };
    }

    const updated = await this.paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: razorpayPaymentId,
      status: "REFUNDED",
      method: payment.method ?? "unknown",
      webhook_event: payload.event,
      webhook_raw: payload,
    });
    if (!updated.applied) {
      return { processed: false, idempotent: true };
    }

    if (payment.gift_id) {
      if (this.giftRepo) {
        // markRefunded is CAS (only REFUNDING/EXPIRED/ACTIVE): a gift that was
        // already fulfilled or cancelled is never regressed by a stale refund.
        const gift = await this.giftRepo.markRefunded(payment.gift_id);
        if (gift) {
          await emit(
            createEventEnvelope("GiftRefunded", payment.gift_id, {
              gift_id: payment.gift_id,
              sender_id: gift.sender_id,
              amount: payment.amount,
            }),
          );
        }
      }
      return { processed: true, idempotent: false, giftStatus: "REFUNDED" };
    }

    if (payment.order_id) {
      // Monotonic CAS: a stale/replayed refund can never clobber a newer order
      // state — only a CONFIRMED (or awaiting-capture) order becomes REFUNDED.
      let moved = await this.orderRepo.updateStatusIf(payment.order_id, "CONFIRMED", "REFUNDED");
      if (!moved) {
        moved = await this.orderRepo.updateStatusIf(
          payment.order_id,
          "PAYMENT_PENDING",
          "REFUNDED",
        );
      }
    }
    return { processed: true, idempotent: false, orderStatus: "REFUNDED" };
  }
}
