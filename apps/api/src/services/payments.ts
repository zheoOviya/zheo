import { createEventEnvelope, emit } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import type { OrderRepository } from "../repositories/orderRepository";
import type { PaymentRepository, PaymentDTO } from "../repositories/paymentRepository";
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

export class PaymentService {
  constructor(
    private readonly paymentRepo: PaymentRepository,
    private readonly orderRepo: OrderRepository,
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

  async processWebhook(
    rawBody: string,
    signatureHeader: string,
  ): Promise<{
    processed: boolean;
    idempotent: boolean;
    orderStatus?: string;
  }> {
    if (!razorpayService.verifyWebhookSignature(rawBody, signatureHeader)) {
      throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Webhook signature verification failed", 401);
    }

    const payload: RazorpayWebhookPayload = JSON.parse(rawBody);
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
}
