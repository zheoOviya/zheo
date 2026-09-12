import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { publishStatusUpdate } from "../lib/websocket";
import { AppError } from "../middleware/envelope";
import type { OrderDTO, OrderRepository } from "../repositories/orderRepository";
import type { GiftDTO, GiftRepository } from "../repositories/giftRepository";
import type {
  FulfillmentGiftRepo,
  FulfillmentTransactionPort,
} from "../repositories/fulfillmentAtomicityContracts";
import { getFulfillmentTransactionPort } from "../repositories/drizzle/fulfillmentTransactionPort";
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
  constructor(
    private readonly orderRepo: OrderRepository,
    _giftRepo?: GiftRepository,
    private readonly txPort?: FulfillmentTransactionPort,
  ) {}

  /**
   * Transaction port for atomic status CAS + gift mutations. Injected port is
   * preferred (tests); otherwise the storage-mode-aware selector is used so the
   * service never branches on storage mode itself and never constructs a
   * Drizzle client directly.
   */
  private getTransactionPort(): FulfillmentTransactionPort {
    return this.txPort ?? getFulfillmentTransactionPort();
  }

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

    // Status CAS is the first mutation; gift unbinds share the same commit
    // boundary, so a partial cancel (status CANCELLED with gifts still bound,
    // or vice versa) is not representable in Postgres.
    const observedStatus = order.status;
    const updated = await this.getTransactionPort().runInTransaction(
      async ({ orders, gifts }) => {
        const cancelled = await orders.transitionStatus(orderId, observedStatus, "CANCELLED");
        if (!cancelled) return null;

        const giftLines = order.items.filter((i) => i.gift_id);
        for (const line of giftLines) {
          // Unbind only when THIS order holds the gift (CAS); a gift already
          // re-deployed into another order stays put.
          if (line.gift_id) await gifts.releaseFromOrder(line.gift_id, order.id);
        }
        return cancelled;
      },
    );

    if (!updated) {
      throw new AppError("INVALID_TRANSITION", "Order is no longer cancellable", 400);
    }

    await publishStatusUpdate({
      order_id: updated.id,
      restaurant_id: updated.restaurant_id,
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

    // WRITE AUTHORITY = CAS against the observed from-status. PREPARING carries
    // its OTP in the same single statement (checkout: status + OTP atomically).
    const observedStatus = order.status;
    let refreshed: OrderDTO | null;
    if (nextStatus === "PREPARING") {
      const otp = randomInt(1000, 10000).toString().padStart(4, "0");
      const qrToken = randomUUID();
      refreshed = await this.orderRepo.claimPreparingWithOtp(orderId, observedStatus, otp, qrToken);
    } else {
      refreshed = await this.orderRepo.transitionStatus(orderId, observedStatus, nextStatus);
    }
    if (!refreshed) {
      // CAS loser: no OTP persisted, no status change, no events.
      throw await this.advanceConflict(orderId, observedStatus, nextStatus);
    }

    // Post-commit only (the CAS statement above is the commit boundary).
    await publishStatusUpdate({
      order_id: refreshed.id,
      restaurant_id: refreshed.restaurant_id,
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

  /** Maps an advance CAS miss to the truthful existing contract where possible. */
  private async advanceConflict(
    orderId: string,
    observedStatus: OrderStatus,
    nextStatus: string,
  ): Promise<AppError> {
    const current = await this.orderRepo.getById(orderId);
    if (!current) {
      return new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }
    const allowed = VALID_TRANSITIONS[current.status];
    if (!allowed || allowed.length === 0) {
      return new AppError(
        "INVALID_TRANSITION",
        `Cannot advance from ${current.status}: terminal state`,
        400,
      );
    }
    return new AppError(
      "CONCURRENT_MODIFICATION",
      `Order status changed from ${observedStatus} while advancing to ${nextStatus}`,
      409,
    );
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

    // Verify QR token or OTP. safeEqual is a cheap early reject only; the
    // authoritative consumption/transition is the CAS below.
    if (qrToken) {
      const byQr = await this.orderRepo.findByQrToken(qrToken);
      if (!byQr || byQr.id !== orderId) {
        throw new AppError("INVALID_QR", "Invalid QR token", 400);
      }

      // QR resolves the order; the status transition is still a CAS so exactly
      // one concurrent pickup wins. QR persistence itself is HELD (F5).
      const result = await this.getTransactionPort().runInTransaction(
        async ({ orders, gifts }) => {
          const picked = await orders.transitionStatus(orderId, "READY_FOR_PICKUP", "PICKED_UP");
          if (!picked) return null;
          const fulfilled = await this.fulfillGiftsTx(gifts, picked);
          return { picked, fulfilled };
        },
      );
      if (!result) {
        throw await this.pickupConflict(orderId);
      }
      await this.afterPickup(result.picked, result.fulfilled, order);
      return result.picked;
    }

    if (pickupOtp) {
      if (!order.pickup_otp || !safeEqual(order.pickup_otp, pickupOtp)) {
        throw new AppError("INVALID_OTP", "Invalid pickup OTP", 400);
      }

      // OTP consumption + PICKED_UP + gift fulfillment share ONE PG transaction.
      const result = await this.getTransactionPort().runInTransaction(
        async ({ orders, gifts }) => {
          const picked = await orders.consumePickupOtp(orderId, "READY_FOR_PICKUP", pickupOtp);
          if (!picked) return null;
          const fulfilled = await this.fulfillGiftsTx(gifts, picked);
          return { picked, fulfilled };
        },
      );
      if (!result) {
        throw await this.pickupConflict(orderId);
      }
      await this.afterPickup(result.picked, result.fulfilled, order);
      return result.picked;
    }

    throw new AppError("MISSING_VERIFICATION", "Provide either qr_token or pickup_otp", 400);
  }

  /** Maps a pickup CAS miss to the truthful existing contract. */
  private async pickupConflict(orderId: string): Promise<AppError> {
    const current = await this.orderRepo.getById(orderId);
    if (!current) {
      return new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }
    if (current.status === "PICKED_UP") {
      return new AppError("ALREADY_PICKED_UP", "This order has already been picked up", 400);
    }
    if (current.status === "READY_FOR_PICKUP") {
      return new AppError("INVALID_OTP", "Invalid pickup OTP", 400);
    }
    return new AppError("NOT_READY", `Order is ${current.status}, not READY_FOR_PICKUP`, 400);
  }

  /** TX-scoped gift CAS fulfillment; emits nothing (events are post-commit). */
  private async fulfillGiftsTx(
    gifts: FulfillmentGiftRepo,
    order: OrderDTO,
  ): Promise<GiftDTO[]> {
    const fulfilled: GiftDTO[] = [];
    for (const line of order.items) {
      const giftId = line.gift_id;
      if (!giftId) continue;
      // CAS fulfill: only from CLAIMED and only when THIS order is the one the
      // gift is bound to. A gift bound to another order (or already fulfilled)
      // returns null, so it is fulfilled and stamped exactly once.
      const gift = await gifts.markFulfilled(giftId, order.id);
      if (!gift) continue;
      fulfilled.push(gift);
    }
    return fulfilled;
  }

  /** Post-commit pickup events/notifications only. */
  private async afterPickup(
    order: OrderDTO,
    fulfilled: GiftDTO[],
    verificationOrder: OrderDTO,
  ): Promise<void> {
    await publishStatusUpdate({
      order_id: order.id,
      restaurant_id: order.restaurant_id,
      status: "PICKED_UP",
    });

    await emit(
      createEventEnvelope("OrderPickedUp", order.id, {
        order_id: order.id,
        restaurant_id: order.restaurant_id,
        pickup_otp: verificationOrder.pickup_otp ?? "000000",
      }),
    );

    for (const gift of fulfilled) {
      await emit(
        createEventEnvelope("GiftFulfilled", gift.id, {
          gift_id: gift.id,
          sender_id: gift.sender_id,
          restaurant_id: gift.restaurant_id,
          order_id: order.id,
        }),
      );
    }
  }
}
