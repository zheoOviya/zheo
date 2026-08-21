import { createEventEnvelope, emit } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import type { GiftRepository } from "../repositories/giftRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import type { PaymentRepository } from "../repositories/paymentRepository";
import { razorpayService, type RazorpayWebhookPayload } from "./razorpay";

// ============================================
// Payments context service (payments bounded context)
// Orchestrates: payment order creation -> payment
// webhook processing with idempotency -> status
// transitions -> event emission.
// ============================================

// Indian-market payment methods. Online methods (upi / card / netbanking /
// wallet) all funnel through the Razorpay checkout (aggregator that already
// supports 100+ methods); "cod" is pay-at-pickup with no gateway.
export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet" | "cod";

// In-process per-gift serialization for payment-order creation. The
// get-then-create idempotency check is read-then-write; without a unique
// constraint on payments.gift_id two concurrent first-time calls could mint
// two Razorpay orders. The mutex closes that window within a single process.
const giftPaymentLocks = new Map<string, Promise<unknown>>();

function withGiftPaymentLock<T>(giftId: string, fn: () => Promise<T>): Promise<T> {
  const prev = giftPaymentLocks.get(giftId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  giftPaymentLocks.set(giftId, run);
  return run.finally(() => {
    if (giftPaymentLocks.get(giftId) === run) giftPaymentLocks.delete(giftId);
  });
}

export class PaymentService {
  constructor(
    private readonly paymentRepo: PaymentRepository,
    private readonly orderRepo: OrderRepository,
    private readonly giftRepo?: GiftRepository,
  ) {}

  async createPaymentOrder(
    orderId: string,
    method: PaymentMethod = "upi",
  ): Promise<{
    payment_method: PaymentMethod;
    razorpay_order_id?: string;
    amount: number;
    currency: string;
  }> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }

    if (order.status !== "DRAFT") {
      throw new AppError(
        "ORDER_NOT_DRAFT",
        `Cannot create payment: order is ${order.status}, not DRAFT`,
        400,
      );
    }

    if (method === "cod") {
      const payment = await this.paymentRepo.create({
        order_id: order.id,
        razorpay_order_id: `cod_${order.id.slice(0, 8)}`,
        amount: order.total_amount,
        method: "cod",
      });

      // Cash is collected at the counter on pickup, so the order goes
      // straight to CONFIRMED and the fulfillment flow proceeds.
      await this.orderRepo.updateStatus(order.id, "CONFIRMED");
      await emit(
        createEventEnvelope("CashOnPickupSelected", order.id, {
          order_id: order.id,
          payment_id: payment.id,
          amount: order.total_amount,
        }),
      );

      return {
        payment_method: "cod",
        amount: order.total_amount,
        currency: "INR",
      };
    }

    const amountInPaise = Math.round(order.total_amount * 100);
    const rpOrder = await razorpayService.createOrder(
      amountInPaise,
      `receipt_${order.id.slice(0, 8)}`,
    );

    await this.paymentRepo.create({
      order_id: order.id,
      razorpay_order_id: rpOrder.id,
      amount: order.total_amount,
    });

    await this.orderRepo.updateStatus(order.id, "PAYMENT_PENDING");

    return {
      payment_method: method,
      razorpay_order_id: rpOrder.id,
      amount: order.total_amount,
      currency: "INR",
    };
  }

  async createGiftPayment(giftId: string): Promise<{
    gift_id: string;
    razorpay_order_id: string;
    amount: number;
    currency: string;
  }> {
    return withGiftPaymentLock(giftId, async () => {
      return this.createGiftPaymentUnlocked(giftId);
    });
  }

  private async createGiftPaymentUnlocked(giftId: string): Promise<{
    gift_id: string;
    razorpay_order_id: string;
    amount: number;
    currency: string;
  }> {
    if (!this.giftRepo) {
      throw new AppError("GIFT_REPO_MISSING", "Gift repository is not configured", 500);
    }
    const gift = await this.giftRepo.getById(giftId);
    if (!gift) {
      throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    }
    if (gift.status !== "PENDING" && gift.status !== "ACTIVE") {
      throw new AppError(
        "GIFT_NOT_PAYABLE",
        `Gift is ${gift.status}, not payable`,
        400,
      );
    }

    // Idempotency: if a Razorpay order was already created for this gift and
    // hasn't been settled, return it instead of minting a duplicate order. A
    // settled payment cannot be re-charged; a FAILED one may be retried.
    const existing = await this.paymentRepo.getByGiftId(giftId);
    if (existing) {
      if (existing.status === "CREATED" || existing.status === "AUTHORIZED") {
        return {
          gift_id: gift.id,
          razorpay_order_id: existing.razorpay_order_id,
          amount: existing.amount,
          currency: existing.currency,
        };
      }
      if (existing.status === "CAPTURED" || existing.status === "REFUNDED") {
        throw new AppError(
          "GIFT_ALREADY_PAID",
          `Gift payment is already ${existing.status}`,
          400,
        );
      }
    }

    const amountInPaise = Math.round(gift.price_paid * 100);
    const rpOrder = await razorpayService.createOrder(
      amountInPaise,
      `gift_${gift.id.slice(0, 8)}`,
    );

    await this.paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: rpOrder.id,
      amount: gift.price_paid,
    });

    return {
      gift_id: gift.id,
      razorpay_order_id: rpOrder.id,
      amount: gift.price_paid,
      currency: "INR",
    };
  }

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

    // IDEMPOTENCY: check if this razorpay_payment_id was already processed
    const existing = await this.paymentRepo.findByRazorpayPaymentId(entity.id);
    if (existing) {
      return { processed: false, idempotent: true };
    }

    // Find internal payment record by Razorpay order ID
    const payment = await this.paymentRepo.findByRazorpayOrderId(entity.order_id);
    if (!payment) {
      throw new AppError(
        "PAYMENT_NOT_FOUND",
        "No payment record found for this Razorpay order",
        404,
      );
    }

    const isCaptured = entity.captured || entity.status === "captured";

    if (payment.gift_id) {
      const updated = await this.paymentRepo.updateWebhookResult(payment.id, {
        razorpay_payment_id: entity.id,
        status: isCaptured ? "CAPTURED" : "FAILED",
        method: entity.method ?? "unknown",
        webhook_event: payload.event,
        webhook_raw: payload,
      });
      if (!updated) {
        throw new AppError("PAYMENT_UPDATE_FAILED", "Failed to update payment record", 500);
      }
      if (isCaptured && this.giftRepo) {
        // markPaid is CAS (PENDING -> ACTIVE) so a concurrent cancel can never
        // be clobbered into ACTIVE; if it fails the gift was cancelled and the
        // capture will need a manual refund instead.
        const gift = await this.giftRepo.markPaid(payment.gift_id);
        if (gift) {
          await emit(
            createEventEnvelope("GiftPaid", payment.gift_id, {
              gift_id: payment.gift_id,
              payment_id: payment.id,
              amount: payment.amount,
            }),
          );
        }
        return { processed: true, idempotent: false, giftStatus: gift?.status ?? "PENDING" };
      }
      return { processed: true, idempotent: false, giftStatus: "PENDING" };
    }

    if (!payment.order_id) {
      throw new AppError(
        "PAYMENT_MISSING_ORDER",
        "Payment record has no order_id to update",
        500,
      );
    }

    const updated = await this.paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: entity.id,
      status: isCaptured ? "CAPTURED" : "FAILED",
      method: entity.method ?? "unknown",
      webhook_event: payload.event,
      webhook_raw: payload,
    });

    if (!updated) {
      throw new AppError("PAYMENT_UPDATE_FAILED", "Failed to update payment record", 500);
    }

    if (isCaptured) {
      await this.orderRepo.updateStatus(payment.order_id, "CONFIRMED");
      await emit(
        createEventEnvelope("PaymentSucceeded", payment.order_id, {
          order_id: payment.order_id,
          payment_id: payment.id,
          amount: payment.amount,
        }),
      );
      return { processed: true, idempotent: false, orderStatus: "CONFIRMED" };
    }

    await this.orderRepo.updateStatus(payment.order_id, "PAYMENT_FAILED");
    await emit(
      createEventEnvelope("PaymentFailed", payment.order_id, {
        order_id: payment.order_id,
        payment_id: payment.id,
        reason: entity.description ?? "Payment failed",
      }),
    );
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

    await this.paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: razorpayPaymentId,
      status: "REFUNDED",
      method: payment.method ?? "unknown",
      webhook_event: payload.event,
      webhook_raw: payload,
    });

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
      await this.orderRepo.updateStatus(payment.order_id, "REFUNDED");
    }
    return { processed: true, idempotent: false, orderStatus: "REFUNDED" };
  }
}
