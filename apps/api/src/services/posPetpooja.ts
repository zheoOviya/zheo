import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "../config";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { logger } from "../lib/logger";
import { AppError } from "../middleware/envelope";
import type { CatalogRepository } from "../repositories/catalogRepository";
import type { IdentityRepository } from "../repositories/identityRepository";
import type { OrderDTO, OrderRepository } from "../repositories/orderRepository";
import {
  isPosOrderMappingDuplicate,
  MemoryPosImportTransactionPort,
  type PosOrderRepository,
} from "../repositories/posRepository";
import type { CustomizationDelta } from "./pricing";
import { OrderingService } from "./ordering";

// ============================================
// Petpooja POS Integration (PRD Phase 2, V01)
//
// Contract:
//   POST /api/v1/webhooks/pos/petpooja
//   Header: x-petpooja-signature = HMAC-SHA256(secret, rawBody) hex
//   Body:   { pos_order_id, restaurant_id?, customer_phone?,
//             ordered_at?, items: [{ pos_item_id, name,
//             quantity, price, customizations? }] }
//
// Order import flow:
//   1. Verify HMAC signature (mock accepts `valid_sig_` prefix).
//   2. Idempotency key = pos_order_id (Petpooja's own order number).
//   3. Resolve customer by phone via the identity repo so POS + web
//      orders share a stable user_id (repeat-rate math stays correct).
//   4. Map pos_item_id -> SnakZap menu item (pricing is always taken
//      from OUR catalog, never trusted from the POS payload).
//   5. Create the order and jump straight to CONFIRMED (POS orders
//      arrive pre-paid; DRAFT/PAYMENT_PENDING are web-channel states).
// ============================================

const MOCK_MODE = config.env === "test" || !config.petpooja.webhookSecret;

// Hard-fail in production when the POS provider is unconfigured instead of
// silently accepting mock webhook signatures for real traffic.
if (config.env === "production" && !config.petpooja.webhookSecret) {
  throw new Error("PETPOOJA_WEBHOOK_SECRET is required in production");
}

export const POS_WALKIN_PHONE = "0000000000";

const CustomizationSchema = z.object({
  name: z.string().min(1),
  price_delta: z.number(),
});

const PosOrderItemSchema = z.object({
  pos_item_id: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().min(1).max(50),
  price: z.number().nonnegative(),
  customizations: z.array(CustomizationSchema).default([]),
});

const PosWebhookSchema = z.object({
  pos_order_id: z.string().min(1),
  restaurant_id: z.string().uuid().optional(),
  customer_phone: z
    .string()
    .regex(/^\+?[0-9]{10,15}$/, "Invalid customer phone")
    .optional(),
  ordered_at: z.string().datetime({ offset: true }).optional(),
  items: z.array(PosOrderItemSchema).min(1, "At least one item is required"),
});

export type PetpoojaWebhookOrder = z.infer<typeof PosWebhookSchema>;

export interface PosImportResult {
  processed: boolean;
  idempotent: boolean;
  order_id?: string;
  order_status?: string;
}

export class PetpoojaPosService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly catalogRepo: CatalogRepository,
    private readonly identityRepo: IdentityRepository,
    private readonly posRepo: PosOrderRepository,
  ) {}

  /** Mock mode mirrors the Razorpay seam: `valid_sig_` prefix when no secret. */
  verifySignature(rawBody: string, signature: string): boolean {
    if (MOCK_MODE) {
      return signature.startsWith("valid_sig_");
    }
    const secret = config.petpooja.webhookSecret;
    if (!secret) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return signature === expected;
  }

  async processOrderWebhook(rawBody: string, signatureHeader: string): Promise<PosImportResult> {
    if (!this.verifySignature(rawBody, signatureHeader)) {
      throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Webhook signature verification failed", 401);
    }

    let payload: PetpoojaWebhookOrder;
    try {
      payload = PosWebhookSchema.parse(JSON.parse(rawBody));
    } catch (err) {
      throw new AppError(
        "INVALID_WEBHOOK",
        "Malformed Petpooja webhook payload",
        400,
        err instanceof z.ZodError ? err.flatten() : undefined,
      );
    }

    // The restaurant must be resolved BEFORE the idempotency precheck: the
    // lookup key is restaurant-scoped, so the same pos_order_id arriving under
    // a different restaurant is a different order and must not collide.
    const restaurantId =
      payload.restaurant_id ?? config.petpooja.defaultRestaurantId;

    // IDEMPOTENCY (fast path): a retried delivery of the same restaurant + POS
    // order number must never create a second SnakZap order. The DB unique
    // index is the final authority; this is only the cheap early-out.
    const existing = await this.posRepo.getByPosOrderId(
      restaurantId,
      payload.pos_order_id,
    );
    if (existing) {
      return {
        processed: false,
        idempotent: true,
        order_id: existing.order_id,
      };
    }

    const restaurant = await this.catalogRepo.getRestaurantById(restaurantId);
    if (!restaurant || !restaurant.is_active) {
      throw new AppError(
        "RESTAURANT_NOT_FOUND",
        "POS order targets an unknown or inactive restaurant",
        404,
      );
    }

    const customer = await this.identityRepo.ensureByPhone(
      payload.customer_phone ?? POS_WALKIN_PHONE,
      "CONSUMER",
    );

    // Map POS item ids to SnakZap menu items; price comes from our catalog.
    const items: {
      menu_item_id: string;
      quantity: number;
      customizations: CustomizationDelta[];
    }[] = [];
    for (const posItem of payload.items) {
      const menuItem = await this.catalogRepo.getMenuItemByPosItemId(
        restaurantId,
        posItem.pos_item_id,
      );
      if (!menuItem || !menuItem.is_available) {
        throw new AppError(
          "POS_ITEM_NOT_SYNCED",
          `POS item ${posItem.pos_item_id} (${posItem.name}) is not synced into the menu. Run a menu sync first.`,
          400,
        );
      }
      items.push({
        menu_item_id: menuItem.id,
        quantity: posItem.quantity,
        customizations: posItem.customizations,
      });
    }

    // ATOMIC IMPORT: the order, ALL of its items, its CONFIRMED status, and
    // the idempotency mapping commit or roll back as ONE transaction. Postgres
    // provides a real transaction port over one connection; memory falls back
    // to a passthrough (no cross-store crash window in a single process).
    const port =
      this.posRepo.transactionPort?.(this.orderRepo) ??
      new MemoryPosImportTransactionPort(this.orderRepo, this.posRepo);

    let order: OrderDTO;
    try {
      order = await port.runInTransaction(async ({ orders, pos }) => {
        // Tx-scoped OrderingService shares the transaction handle so the order
        // and its items are written on the SAME connection. The checkout tx port
        // is disabled (useCheckoutTx:false) because this import already runs
        // inside its own transaction; wrapping again would open a second,
        // unrelated transaction. OrderCreated is suppressed
        // (emitOrderCreated:false) because emitting before commit could publish
        // a phantom event for an order that then rolls back.
        const txOrdering = new OrderingService(
          orders as unknown as OrderRepository,
          this.catalogRepo,
        );
        const created = await txOrdering.placeOrder(
          {
            user_id: customer.id,
            restaurant_id: restaurantId,
            items,
            scheduled_pickup_time: payload.ordered_at,
          },
          { emitOrderCreated: false, useCheckoutTx: false },
        );

        // Pre-paid POS order -> skip DRAFT/PAYMENT_PENDING, go to CONFIRMED.
        await orders.updateStatus(created.id, "CONFIRMED");
        await pos.recordOrder(restaurantId, payload.pos_order_id, created.id);
        return created;
      });
    } catch (err) {
      // Lost a concurrent-import race: the winner committed, the DB unique
      // index rejected our mapping, and our WHOLE transaction rolled back.
      // Re-read the winner and report idempotent. Only the exact POS-mapping
      // constraint qualifies; any other 23505 propagates untouched.
      if (!isPosOrderMappingDuplicate(err)) {
        throw err;
      }
      const winner = await this.posRepo.getByPosOrderId(
        restaurantId,
        payload.pos_order_id,
      );
      if (!winner) {
        // Never fabricate success: the duplicate exists but is unreadable.
        throw new AppError(
          "POS_IMPORT_CONFLICT_UNRESOLVED",
          "POS import lost the idempotency race but no winning mapping is readable",
          500,
        );
      }
      return {
        processed: false,
        idempotent: true,
        order_id: winner.order_id,
      };
    }

    // Post-commit events only. Both are best-effort (emit never throws), so a
    // subscriber failure can never roll back an already-committed import, and
    // the loser above emits ZERO events.
    await emit(
      createEventEnvelope("OrderCreated", order.id, { order }, {
        correlation_id: randomUUID(),
      }),
    );
    await emit(
      createEventEnvelope("PosOrderImported", order.id, {
        order_id: order.id,
        pos_order_id: payload.pos_order_id,
        restaurant_id: restaurantId,
      }),
    );

    logger.info({
      message: "pos_order_imported",
      pos_order_id: payload.pos_order_id,
      order_id: order.id,
      restaurant_id: restaurantId,
    });

    return {
      processed: true,
      idempotent: false,
      order_id: order.id,
      order_status: "CONFIRMED",
    };
  }
}
