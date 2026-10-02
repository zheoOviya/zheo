import { randomInt, timingSafeEqual } from "node:crypto";
import { createEventEnvelope } from "../lib/eventBus";
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

// Manual consumer check-in is allowed only while the order is actively being
// fulfilled. DRAFT/PAYMENT_PENDING are not yet confirmed, and every terminal
// state (PICKED_UP/CANCELLED/REFUNDED/PAYMENT_FAILED/EXPIRED/DISPUTED/SETTLED)
// must never admit a new check-in. Geo auto-arrival keeps its own READY-only
// gate in geoFence.ts; this set governs manual check-in only.
const MANUAL_CHECKIN_ALLOWED = new Set<OrderStatus>([
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
]);

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
    // The CAS and the durable OrderPreparationStarted / OrderReadyForPickup /
    // EarlyReadyAlert rows share ONE PG transaction (EVT-B2B-NP2), so a CAS
    // loser or a rollback persists no event row and the old post-commit emit is
    // gone. WebSocket fan-out stays post-commit.
    const observedStatus = order.status;
    const txResult = await this.getTransactionPort().runInTransaction(
      async ({ orders, outbox }) => {
        let refreshed: OrderDTO | null;
        if (nextStatus === "PREPARING") {
          const otp = randomInt(1000, 10000).toString().padStart(4, "0");
          refreshed = await orders.claimPreparingWithOtp(orderId, observedStatus, otp);
        } else {
          refreshed = await orders.transitionStatus(orderId, observedStatus, nextStatus);
        }
        if (!refreshed) return null;

        if (nextStatus === "PREPARING") {
          await outbox.enqueue(
            createEventEnvelope("OrderPreparationStarted", refreshed.id, {
              order_id: refreshed.id,
              restaurant_id: refreshed.restaurant_id,
            }),
          );
        }

        let earlyReadyAlerted = false;
        if (nextStatus === "READY_FOR_PICKUP") {
          await outbox.enqueue(
            createEventEnvelope("OrderReadyForPickup", refreshed.id, {
              order_id: refreshed.id,
              restaurant_id: refreshed.restaurant_id,
            }),
          );

          // P13 Early Ready Alert: the order became ready BEFORE its scheduled
          // pickup time, so the notification layer should nudge the customer
          // (Push Notification / SMS) - they can pick up sooner than planned.
          // It shares the READY transition's transaction, so it can never
          // commit on its own or land in a second post-commit window.
          if (refreshed.scheduled_pickup_time) {
            const scheduled = Date.parse(refreshed.scheduled_pickup_time);
            if (Number.isFinite(scheduled) && scheduled > Date.now()) {
              earlyReadyAlerted = true;
              await outbox.enqueue(
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

        return { refreshed, earlyReadyAlerted };
      },
    );
    if (!txResult) {
      // CAS loser: no OTP persisted, no status change, no events.
      throw await this.advanceConflict(orderId, observedStatus, nextStatus);
    }

    // Post-commit only (the transaction above is the commit boundary).
    await publishStatusUpdate({
      order_id: txResult.refreshed.id,
      restaurant_id: txResult.refreshed.restaurant_id,
      status: nextStatus,
    });

    return {
      order: txResult.refreshed,
      nextStatus,
      earlyReadyAlerted: txResult.earlyReadyAlerted,
    };
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

    // Status eligibility is evaluated BEFORE the checked_in idempotency
    // short-circuit, so a historical terminal order that happens to carry
    // checked_in=true cannot make a new request appear valid.
    if (!MANUAL_CHECKIN_ALLOWED.has(order.status)) {
      throw new AppError(
        "CHECKIN_NOT_ALLOWED",
        `Order in ${order.status} cannot be checked in`,
        400,
      );
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

  async confirmPickup(orderId: string, pickupOtp?: string): Promise<OrderDTO> {
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

    // The pickup OTP is the only handover credential. safeEqual is a cheap
    // early reject only; the authoritative consumption/transition is the CAS
    // below.
    if (pickupOtp) {
      if (!order.pickup_otp || !safeEqual(order.pickup_otp, pickupOtp)) {
        throw new AppError("INVALID_OTP", "Invalid pickup OTP", 400);
      }

      // OTP consumption + PICKED_UP + gift fulfillment + the durable event rows
      // share ONE PG transaction, so the events commit iff the pickup commits.
      const result = await this.getTransactionPort().runInTransaction(
        async ({ orders, gifts, outbox }) => {
          const picked = await orders.consumePickupOtp(orderId, "READY_FOR_PICKUP", pickupOtp);
          if (!picked) return null;
          const fulfilled = await this.fulfillGiftsTx(gifts, picked);
          await outbox.enqueue(
            createEventEnvelope("OrderPickedUp", picked.id, {
              order_id: picked.id,
              restaurant_id: picked.restaurant_id,
            }),
          );
          for (const gift of fulfilled) {
            await outbox.enqueue(
              createEventEnvelope("GiftFulfilled", gift.id, {
                gift_id: gift.id,
                sender_id: gift.sender_id,
                restaurant_id: gift.restaurant_id,
                order_id: picked.id,
              }),
            );
          }
          return { picked, fulfilled };
        },
      );
      if (!result) {
        throw await this.pickupConflict(orderId);
      }
      await this.afterPickup(result.picked);
      return result.picked;
    }

    throw new AppError("MISSING_VERIFICATION", "Provide pickup_otp", 400);
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

  /**
   * Post-commit pickup side effects only. The durable OrderPickedUp /
   * GiftFulfilled events are enqueued INSIDE the pickup transaction (EVT-B2A),
   * so this method must not emit them again (that would double-deliver).
   */
  private async afterPickup(order: OrderDTO): Promise<void> {
    await publishStatusUpdate({
      order_id: order.id,
      restaurant_id: order.restaurant_id,
      status: "PICKED_UP",
    });
  }
}
