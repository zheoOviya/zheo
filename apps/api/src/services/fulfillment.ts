import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { publishStatusUpdate } from "../lib/websocket";
import { AppError } from "../middleware/envelope";
import type { OrderDTO, OrderRepository } from "../repositories/orderRepository";
import type { OrderStatus } from "@snakzap/types";

// ============================================
// Fulfillment context service (fulfillment bounded context)
// Enforces sequential state machine transitions,
// generates OTP/QR tokens, handles check-in and
// pickup confirmation, broadcasts WebSocket events.
// ============================================

// Constant-time string comparison to avoid leaking OTP comparisons
// through timing side-channels (both sides are 4-digit numeric strings).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CONFIRMED: ["PREPARING"],
  PREPARING: ["ALMOST_READY"],
  ALMOST_READY: ["READY_FOR_PICKUP"],
  READY_FOR_PICKUP: ["PICKED_UP"],
  PICKED_UP: [],
  PAYMENT_FAILED: [],
  CANCELLED: [],
  DRAFT: [],
  PAYMENT_PENDING: [],
  REFUNDED: [],
  EXPIRED: [],
  DISPUTED: [],
  SETTLED: [],
};

export class FulfillmentService {
  constructor(private readonly orderRepo: OrderRepository) {}

  /**
   * Vendor cancellation. Allowed only before the order becomes ready for
   * pickup (a ready order must be handed over or handled via pickup OTP).
   */
  async cancelOrder(orderId: string): Promise<OrderDTO> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }
    const cancellable = new Set<OrderStatus>([
      "DRAFT",
      "PAYMENT_PENDING",
      "CONFIRMED",
      "PREPARING",
    ]);
    if (!cancellable.has(order.status)) {
      throw new AppError("INVALID_TRANSITION", `Order in ${order.status} cannot be cancelled`, 400);
    }

    const updated = await this.orderRepo.updateStatus(orderId, "CANCELLED");
    if (!updated) {
      throw new AppError("UPDATE_FAILED", "Failed to update order status", 500);
    }

    await publishStatusUpdate({
      order_id: order.id,
      restaurant_id: order.restaurant_id,
      status: "CANCELLED",
    });
    return updated;
  }

  async advanceOrderStatus(
    orderId: string,
  ): Promise<{ order: OrderDTO; nextStatus: string; earlyReadyAlerted: boolean }> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }

    const allowed = VALID_TRANSITIONS[order.status];
    if (!allowed || allowed.length === 0) {
      throw new AppError(
        "INVALID_TRANSITION",
        `Cannot advance from ${order.status}: terminal state`,
        400,
      );
    }

    const nextStatus = allowed[0];
    if (!nextStatus) {
      throw new AppError("INVALID_TRANSITION", "No next state defined", 400);
    }

    const updated = await this.orderRepo.updateStatus(orderId, nextStatus);
    if (!updated) {
      throw new AppError("UPDATE_FAILED", "Failed to update order status", 500);
    }

    if (nextStatus === "PREPARING") {
      const otp = randomInt(1000, 10000).toString().padStart(4, "0");
      const qrToken = randomUUID();
      await this.orderRepo.setPickupOtp(orderId, otp, qrToken);
    }

    // Re-read to include OTP/QR
    const refreshed = await this.orderRepo.getById(orderId);
    if (!refreshed) {
      throw new AppError("UPDATE_FAILED", "Order disappeared after update", 500);
    }

    // Emit WebSocket event
    await publishStatusUpdate({
      order_id: order.id,
      restaurant_id: order.restaurant_id,
      status: nextStatus,
    });

    // Emit domain events
    if (nextStatus === "PREPARING") {
      await emit(
        createEventEnvelope("OrderPreparationStarted", refreshed.id, {
          order_id: refreshed.id,
          restaurant_id: refreshed.restaurant_id,
        }),
      );
    }

    let earlyReadyAlerted = false;
    if (nextStatus === "READY_FOR_PICKUP") {
      await emit(
        createEventEnvelope("OrderReadyForPickup", refreshed.id, {
          order_id: refreshed.id,
          restaurant_id: refreshed.restaurant_id,
        }),
      );

      // P13 Early Ready Alert: the order became ready BEFORE its scheduled
      // pickup time, so the notification layer should nudge the customer
      // (Push Notification / SMS) - they can pick up sooner than planned.
      if (refreshed.scheduled_pickup_time) {
        const scheduled = Date.parse(refreshed.scheduled_pickup_time);
        if (Number.isFinite(scheduled) && scheduled > Date.now()) {
          earlyReadyAlerted = true;
          await emit(
            createEventEnvelope("EarlyReadyAlert", refreshed.id, {
              order_id: refreshed.id,
              restaurant_id: refreshed.restaurant_id,
              scheduled_pickup_time: refreshed.scheduled_pickup_time,
              ready_time: new Date().toISOString(),
            }),
          );
        }
      }
    }

    return { order: refreshed, nextStatus, earlyReadyAlerted };
  }

  async checkIn(orderId: string): Promise<OrderDTO> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }

    if (order.checked_in) {
      return order;
    }

    const updated = await this.orderRepo.setCheckedIn(orderId);
    if (!updated) {
      throw new AppError("CHECKIN_FAILED", "Failed to check in", 500);
    }

    return updated;
  }

  async confirmPickup(orderId: string, qrToken?: string, pickupOtp?: string): Promise<OrderDTO> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }

    if (order.status === "PICKED_UP") {
      throw new AppError("ALREADY_PICKED_UP", "This order has already been picked up", 400);
    }

    if (order.status !== "READY_FOR_PICKUP") {
      throw new AppError("NOT_READY", `Order is ${order.status}, not READY_FOR_PICKUP`, 400);
    }

    // Verify QR token or OTP
    if (qrToken) {
      const byQr = await this.orderRepo.findByQrToken(qrToken);
      if (!byQr || byQr.id !== orderId) {
        throw new AppError("INVALID_QR", "Invalid QR token", 400);
      }
    } else if (pickupOtp) {
      if (!order.pickup_otp || !safeEqual(order.pickup_otp, pickupOtp)) {
        throw new AppError("INVALID_OTP", "Invalid pickup OTP", 400);
      }
    } else {
      throw new AppError("MISSING_VERIFICATION", "Provide either qr_token or pickup_otp", 400);
    }

    const updated = await this.orderRepo.updateStatus(orderId, "PICKED_UP");
    if (!updated) {
      throw new AppError("PICKUP_FAILED", "Failed to confirm pickup", 500);
    }

    await publishStatusUpdate({
      order_id: order.id,
      restaurant_id: order.restaurant_id,
      status: "PICKED_UP",
    });

    await emit(
      createEventEnvelope("OrderPickedUp", order.id, {
        order_id: order.id,
        restaurant_id: order.restaurant_id,
        pickup_otp: order.pickup_otp ?? "000000",
      }),
    );

    return updated;
  }
}
