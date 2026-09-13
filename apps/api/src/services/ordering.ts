import { createHash, randomUUID } from "node:crypto";
import type { CatalogRepository } from "../repositories/catalogRepository";
import type { GiftRepository } from "../repositories/giftRepository";
import type { CheckoutIdempotencyRepository } from "../repositories/checkoutIdempotencyRepository";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import {
  type OrderRepository,
  type CreateOrderInput,
  type OrderDTO,
} from "../repositories/orderRepository";
import type { OrderCheckoutTransactionPort } from "../repositories/orderCheckoutContracts";
import {
  passthroughOrderCheckoutTransactionPort,
  selectOrderCheckoutTransactionPort,
} from "../repositories/drizzle/orderCheckoutTransactionPort";
import {
  calculatePriceBreakdown,
  type CustomizationDelta,
  type OrderItemInput,
} from "./pricing";
import { assertValidPickupSlot } from "./pickupSlotPolicy";

// ============================================
// Ordering context service (ordering bounded context)
// Orchestrates: validation -> pricing -> persistence -> event emission.
// ============================================

/**
 * Write-time scheduling validation policy. `"pickup-slot"` enforces the
 * consumer pickup-slot calendar; `"none"` (the default) preserves the value
 * verbatim. Internal importers such as the POS webhook are not choosing a
 * consumer pickup slot and must never be rejected by that calendar.
 */
export type SchedulingPolicy = "none" | "pickup-slot";

export interface PlaceOrderRequest {
  user_id: string;
  restaurant_id: string;
  items: {
    menu_item_id: string;
    quantity: number;
    customizations: CustomizationDelta[];
    gift_id?: string;
  }[];
  scheduled_pickup_time?: string;
  scheduling_policy?: SchedulingPolicy;
}

// ============================================
// Idempotency key + canonical fingerprint
// (ORDER-IDEMPOTENCY-DURABILITY-A2).
// ============================================

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * Normalizes the client-supplied Idempotency-Key header value. A missing header
 * (undefined) preserves legacy checkout; a present-but-blank or over-long key is
 * a client validation error. Keys are opaque, so only whitespace is trimmed.
 * x-correlation-id is never consulted.
 */
export function normalizeIdempotencyKey(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new AppError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be a non-empty string",
      400,
    );
  }
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new AppError(
      "INVALID_IDEMPOTENCY_KEY",
      `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      400,
    );
  }
  return trimmed;
}

/**
 * SHA-256 over the canonical economically relevant checkout inputs. Excludes
 * client totals/prices, server-derived breakdowns, correlation ids and
 * timestamps. Logically identical payloads (item/customization order, offset vs
 * Z formatting of the same instant) hash identically.
 */
export function canonicalCheckoutFingerprint(
  request: PlaceOrderRequest,
): string {
  const lines = request.items
    .map((item) => {
      const customizations = item.customizations
        .map((c) => ({
          name: String(c.name),
          price_delta: String(c.price_delta),
        }))
        .sort((a, b) =>
          a.name === b.name
            ? a.price_delta.localeCompare(b.price_delta)
            : a.name.localeCompare(b.name),
        );
      return JSON.stringify({
        menu_item_id: item.menu_item_id,
        quantity: item.quantity,
        customizations,
        gift_id: item.gift_id ?? null,
      });
    })
    .sort();

  const scheduled = request.scheduled_pickup_time
    ? new Date(request.scheduled_pickup_time).toISOString()
    : null;

  const canonical = JSON.stringify({
    restaurant_id: request.restaurant_id,
    items: lines,
    scheduled_pickup_time: scheduled,
  });

  return createHash("sha256").update(canonical).digest("hex");
}

export class OrderingService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly catalogRepo: CatalogRepository,
    private readonly giftRepo?: GiftRepository,
    private readonly checkoutTxPort?: OrderCheckoutTransactionPort,
    private readonly idempotencyRepo?: CheckoutIdempotencyRepository,
  ) {}

  /**
   * Resolves the transaction port lazily so the storage-mode decision is made
   * after the runtime probe, not at module/route construction time.
   */
  private getCheckoutPort(): OrderCheckoutTransactionPort {
    return (
      this.checkoutTxPort ??
      selectOrderCheckoutTransactionPort(
        this.orderRepo,
        this.giftRepo,
        this.idempotencyRepo,
      )
    );
  }

  async placeOrder(
    request: PlaceOrderRequest,
    options?: { emitOrderCreated?: boolean; useCheckoutTx?: boolean },
  ): Promise<OrderDTO> {
    const { order } = await this.runCheckout(request, options ?? {});
    return order;
  }

  /**
   * Consumer checkout entrypoint that honors a durable Idempotency-Key.
   * `replayed` is true when an existing committed order was returned instead of
   * creating a new one (callers map that to HTTP 200 vs 201). No key -> legacy
   * behavior with replayed=false.
   */
  async placeOrderIdempotent(
    request: PlaceOrderRequest,
    idempotencyKey?: string,
  ): Promise<{ order: OrderDTO; replayed: boolean }> {
    return this.runCheckout(request, { idempotencyKey });
  }

  private async runCheckout(
    request: PlaceOrderRequest,
    options: {
      emitOrderCreated?: boolean;
      useCheckoutTx?: boolean;
      idempotencyKey?: string;
    },
  ): Promise<{ order: OrderDTO; replayed: boolean }> {
    const restaurant = await this.catalogRepo.getRestaurantById(
      request.restaurant_id,
    );
    if (!restaurant || !restaurant.is_active) {
      throw new AppError(
        "RESTAURANT_NOT_FOUND",
        "Restaurant not found or inactive",
        404,
      );
    }

    if (request.items.length === 0) {
      throw new AppError("EMPTY_ORDER", "At least one item is required", 400);
    }

    // A consumer-chosen pickup slot must be one the booking display currently
    // offers. Callers that omit the policy (e.g. the POS importer supplying a
    // provider timestamp) keep their value verbatim.
    if (
      request.scheduling_policy === "pickup-slot" &&
      request.scheduled_pickup_time !== undefined
    ) {
      assertValidPickupSlot(request.scheduled_pickup_time);
    }

    // A gift is single-use: reject a request that lists the same gift_id on
    // more than one line before anything is priced or persisted.
    const requestedGiftIds = request.items
      .map((i) => i.gift_id)
      .filter((g): g is string => !!g);
    if (new Set(requestedGiftIds).size !== requestedGiftIds.length) {
      throw new AppError(
        "DUPLICATE_GIFT",
        "A gift can only be redeemed once per order",
        400,
      );
    }

    const orderItems: OrderItemInput[] = [];

    for (const item of request.items) {
      if (item.quantity < 1) {
        throw new AppError(
          "INVALID_QUANTITY",
          `Quantity must be >= 1 for item ${item.menu_item_id}`,
          400,
        );
      }

      const menuItem = await this.catalogRepo.getMenuItemById(
        item.menu_item_id,
      );
      if (!menuItem || !menuItem.is_available) {
        throw new AppError(
          "ITEM_NOT_FOUND",
          `Menu item ${item.menu_item_id} not found or unavailable`,
          404,
        );
      }

      if (menuItem.restaurant_id !== request.restaurant_id) {
        throw new AppError(
          "ITEM_RESTAURANT_MISMATCH",
          `Item ${item.menu_item_id} does not belong to restaurant ${request.restaurant_id}`,
          400,
        );
      }

      let basePrice = menuItem.price;
      let customizations = item.customizations;
      let giftId: string | null = null;

      if (item.gift_id) {
        if (!this.giftRepo) {
          throw new AppError("GIFT_REPO_MISSING", "Gift repository is not configured", 500);
        }
        const gift = await this.giftRepo.getById(item.gift_id);
        if (!gift) {
          throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
        }
        if (gift.status !== "CLAIMED" || gift.claimed_by !== request.user_id) {
          throw new AppError(
            "ITEM_GIFT_MISMATCH",
            `Gift ${gift.id} is not claimed by this user`,
            400,
          );
        }
        if (gift.restaurant_id !== request.restaurant_id || gift.menu_item_id !== item.menu_item_id) {
          throw new AppError(
            "ITEM_GIFT_MISMATCH",
            `Gift ${gift.id} does not match the requested item or restaurant`,
            400,
          );
        }
        if (Date.parse(gift.expires_at) <= Date.now()) {
          throw new AppError("GIFT_EXPIRED", "This gift has expired", 400);
        }
        basePrice = 0;
        // The sender already paid for the customizations in gift.price_paid;
        // keep the names for display but zero the deltas so the recipient
        // pays nothing.
        customizations = gift.item_snapshot.customizations.map((c) => ({
          name: c.name,
          price_delta: 0,
        }));
        giftId = gift.id;
      }

      orderItems.push({
        menu_item_id: item.menu_item_id,
        name: menuItem.name,
        base_price: basePrice,
        // A claimed gift redeems exactly one unit server-side.
        quantity: item.gift_id ? 1 : item.quantity,
        customizations,
        gift_id: giftId,
      });
    }

    const breakdown = calculatePriceBreakdown(orderItems);

    const input: CreateOrderInput = {
      user_id: request.user_id,
      restaurant_id: request.restaurant_id,
      items: orderItems.map((oi) => ({
        menu_item_id: oi.menu_item_id,
        name: oi.name,
        base_price: oi.base_price,
        quantity: oi.quantity,
        customizations: oi.customizations,
        gift_id: oi.gift_id ?? null,
        customization_total:
          breakdown.items.find((b) => b.menu_item_id === oi.menu_item_id)
            ?.customization_total ?? 0,
        item_subtotal:
          breakdown.items.find((b) => b.menu_item_id === oi.menu_item_id)
            ?.item_subtotal ?? 0,
      })),
      breakdown,
      scheduled_pickup_time: request.scheduled_pickup_time,
    };

    const idempotencyKey = options.idempotencyKey;
    const fingerprint = idempotencyKey
      ? canonicalCheckoutFingerprint(request)
      : null;

    // Consumer checkout aggregate: the order row, EVERY order item, and each
    // gift bind execute on one commit boundary. In Postgres the tx handle makes
    // a lost gift CAS (or any throw) roll the whole aggregate back; the memory
    // port is an explicit passthrough, so the in-callback compensation keeps the
    // historical "no leaked DRAFT" behaviour there. When a key is present the
    // idempotency claim joins that same boundary.
    const checkoutPort =
      options.useCheckoutTx === false
        ? passthroughOrderCheckoutTransactionPort(
            this.orderRepo,
            this.giftRepo,
            this.idempotencyRepo,
          )
        : this.getCheckoutPort();

    let claimedClaimId: string | null = null;

    let result: { order: OrderDTO; replayed: boolean };
    try {
      result = await checkoutPort.runInTransaction(
        async ({ orders, gifts, idempotency }) => {
          if (idempotencyKey) {
            if (!idempotency) {
              throw new AppError(
                "IDEMPOTENCY_UNAVAILABLE",
                "Checkout idempotency is not configured",
                500,
              );
            }

            const claim = await idempotency.claim({
              user_id: request.user_id,
              idempotency_key: idempotencyKey,
              request_fingerprint: fingerprint!,
            });

            if (claim.outcome === "EXISTS") {
              if (claim.record.request_fingerprint !== fingerprint) {
                throw new AppError(
                  "IDEMPOTENCY_KEY_REUSED",
                  "Idempotency-Key was already used with a different request payload",
                  409,
                );
              }
              if (!claim.record.order_id) {
                throw new AppError(
                  "IDEMPOTENCY_STATE_INCONSISTENT",
                  "Idempotency claim has no committed order",
                  500,
                );
              }
              const existing = await orders.getById(claim.record.order_id);
              if (!existing) {
                throw new AppError(
                  "IDEMPOTENCY_ORDER_MISSING",
                  "Idempotent order could not be reloaded",
                  500,
                );
              }
              return { order: existing, replayed: true };
            }

            claimedClaimId = claim.record.id;
          }

          const created = await orders.create(input);

          // Bind each claimed gift to THIS order (CAS). bindToOrder only
          // succeeds while the gift is still CLAIMED and unbound, so a gift can
          // never be redeemed in two orders even under concurrent checkout.
          const giftIds = [
            ...new Set(
              orderItems.filter((oi) => oi.gift_id).map((oi) => oi.gift_id!),
            ),
          ];
          if (giftIds.length > 0) {
            if (!this.giftRepo) {
              throw new AppError(
                "GIFT_REPO_MISSING",
                "Gift repository is not configured",
                500,
              );
            }
            const bound: string[] = [];
            for (const giftId of giftIds) {
              const boundGift = await gifts.bindToOrder(giftId, created.id);
              if (!boundGift) {
                // A concurrent order already redeemed this gift. Undo the binds
                // we already made and retire this checkout order. Under Postgres
                // the throw rolls all of this back anyway; under memory this is
                // what prevents a leaked DRAFT order.
                for (const b of bound) {
                  await gifts.releaseFromOrder(b, created.id);
                }
                await orders.updateStatus(created.id, "CANCELLED");
                throw new AppError(
                  "GIFT_ALREADY_REDEEMED",
                  `Gift ${giftId} has already been redeemed in another order`,
                  409,
                );
              }
              bound.push(giftId);
            }
          }

          if (claimedClaimId && idempotency) {
            await idempotency.attachOrder(claimedClaimId, created.id);
          }

          return { order: created, replayed: false };
        },
      );
    } catch (err) {
      // Memory has no rollback, so an uncommitted claim must be released
      // explicitly on any failure. On Postgres the transaction already rolled
      // the claim back, so this delete is a harmless no-op. Never mask the
      // original checkout error.
      if (claimedClaimId && this.idempotencyRepo) {
        try {
          await this.idempotencyRepo.releaseClaim(claimedClaimId);
        } catch {
          // best effort
        }
      }
      throw err;
    }

    // `emitOrderCreated` defaults to true so normal checkout/reorder keep the
    // baseline behaviour. Internal importers that must emit AFTER their own
    // commit boundary (the POS importer) pass false and emit post-commit
    // themselves, so a rolled-back order can never publish a phantom event.
    // A replayed checkout MUST NOT re-emit: the event belongs to the original
    // creation only.
    if (options.emitOrderCreated !== false && !result.replayed) {
      await emit(
        createEventEnvelope("OrderCreated", result.order.id, { order: result.order }, {
          correlation_id: randomUUID(),
        }),
      );
    }

    return result;
  }

  async reorder(userId: string, oldOrderId: string): Promise<OrderDTO> {
    const oldOrder = await this.orderRepo.getById(oldOrderId);
    if (!oldOrder) {
      throw new AppError("ORDER_NOT_FOUND", "Original order not found", 404);
    }

    const items = oldOrder.items.map((item) => ({
      menu_item_id: item.menu_item_id,
      quantity: item.quantity,
      customizations: item.customizations,
      gift_id: undefined,
    }));

    return this.placeOrder({
      user_id: userId,
      restaurant_id: oldOrder.restaurant_id,
      items,
      scheduled_pickup_time: oldOrder.scheduled_pickup_time ?? undefined,
      // Catering uses advance event scheduling, so its stored date must not be
      // re-judged against the consumer pickup calendar. Standard orders are
      // re-validated: a now-past slot is rejected rather than silently copied.
      scheduling_policy: oldOrder.is_catering === true ? "none" : "pickup-slot",
    });
  }
}
