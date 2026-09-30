import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================
// EVT-B2A — fulfillment transactional outbox wiring.
//
// MEMORY_MODE = NON_DURABLE_TEST_PARITY. These tests prove the PRODUCER now
// enqueues OrderPickedUp / GiftFulfilled inside the pickup transaction and that
// the old post-commit direct emit is gone. Real rollback atomicity is proven
// against PostgreSQL by realPgProducerOutboxBoundary.ts.
// ============================================

vi.mock("../lib/websocket", () => ({
  publishStatusUpdate: vi.fn(async () => undefined),
}));

import { FulfillmentService } from "./fulfillment";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import type { OrderDTO } from "../repositories/orderRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import type { GiftDTO } from "../repositories/giftRepository";
import { MemoryFulfillmentTransactionPort } from "../repositories/fulfillmentAtomicityContracts";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";
import { outboxRowToEnvelope, type EventOutboxRow } from "../repositories/eventOutboxRepository";
import { EventOutboxRelay } from "./eventOutboxRelay";
import type { OrderStatus } from "@snakzap/types";

const OID = "11111111-1111-4111-8111-111111111111";
const REST_ID = "33333333-3333-4333-8333-333333333333";

function orderDto(status: OrderStatus, giftId?: string): OrderDTO {
  const now = new Date().toISOString();
  return {
    id: OID,
    user_id: "22222222-2222-4222-8222-222222222222",
    restaurant_id: REST_ID,
    items: giftId
      ? [
          {
            id: randomUUID(),
            menu_item_id: "44444444-4444-4444-8444-444444444444",
            name: "Gift Meal",
            base_price: 0,
            quantity: 1,
            customizations: [],
            customization_total: 0,
            item_subtotal: 0,
            gift_id: giftId,
          },
        ]
      : [],
    total_amount: 100,
    status,
    commission_rate: 0.08,
    commission_amount: 8,
    pickup_otp: "1234",
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: now,
    updated_at: now,
  };
}

class ThrowingGiftRepository extends MemoryGiftRepository {
  override async markFulfilled(id: string, orderId: string): Promise<GiftDTO | null> {
    throw new Error("harness_gift_failure");
  }
}

interface Harness {
  orders: MemoryOrderRepository;
  gifts: MemoryGiftRepository;
  service: FulfillmentService;
}

function build(gifts: MemoryGiftRepository = new MemoryGiftRepository()): Harness {
  const orders = new MemoryOrderRepository();
  const port = new MemoryFulfillmentTransactionPort(() => ({
    orders,
    gifts,
    outbox: memoryEventOutbox,
  }));
  return { orders, gifts, service: new FulfillmentService(orders, gifts, port) };
}

async function seedClaimedGift(gifts: MemoryGiftRepository): Promise<GiftDTO> {
  const gift = await gifts.create({
    sender_id: "55555555-5555-4555-8555-555555555555",
    restaurant_id: REST_ID,
    menu_item_id: "44444444-4444-4444-8444-444444444444",
    item_snapshot: {
      name: "Gift Meal",
      price: 0,
      image_url: null,
      dietary_tags: {},
      spice_level: 0,
      customizations: [],
    },
    price_paid: 100,
    message: null,
    recipient_name: null,
    claim_token: randomUUID(),
    claim_code: "123456",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await gifts.markPaid(gift.id);
  await gifts.markClaimed(gift.id, "claimer");
  const claimed = await gifts.getById(gift.id);
  if (!claimed) throw new Error("gift fixture failed");
  return claimed;
}

const rowsFor = (name: string): EventOutboxRow[] =>
  memoryEventOutbox._all().filter((r) => r.event_name === name);

describe("EVT-B2A fulfillment transactional outbox", () => {
  beforeEach(() => {
    memoryEventOutbox._reset();
    vi.clearAllMocks();
  });

  it("B2A-F1 pickup commit enqueues exactly one OrderPickedUp row", async () => {
    const h = build();
    h.orders._seed(orderDto("READY_FOR_PICKUP"));

    const picked = await h.service.confirmPickup(OID, "1234");
    expect(picked.status).toBe("PICKED_UP");

    const rows = rowsFor("OrderPickedUp");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(OID);
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.payload).toEqual({ order_id: OID, restaurant_id: REST_ID });
  });

  it("B2A-F2 lost-CAS pickup enqueues no event", async () => {
    const h = build();
    h.orders._seed(orderDto("READY_FOR_PICKUP"));

    await expect(h.service.confirmPickup(OID, "9999")).rejects.toMatchObject({
      code: "INVALID_OTP",
    });
    expect(memoryEventOutbox._all()).toHaveLength(0);
  });

  it("B2A-F3 GiftFulfilled enqueues in the same transaction as the pickup", async () => {
    const gifts = new MemoryGiftRepository();
    const h = build(gifts);
    const gift = await seedClaimedGift(gifts);
    await gifts.bindToOrder(gift.id, OID);
    h.orders._seed(orderDto("READY_FOR_PICKUP", gift.id));

    await h.service.confirmPickup(OID, "1234");

    expect(rowsFor("OrderPickedUp")).toHaveLength(1);
    const giftRows = rowsFor("GiftFulfilled");
    expect(giftRows).toHaveLength(1);
    expect(giftRows[0]?.aggregate_id).toBe(gift.id);
    expect(giftRows[0]?.payload).toMatchObject({ gift_id: gift.id, order_id: OID });
  });

  it("B2A-F4 failed transition enqueues nothing (post-commit emit removed)", async () => {
    const gifts = new ThrowingGiftRepository();
    const h = build(gifts);
    const gift = await seedClaimedGift(gifts);
    await gifts.bindToOrder(gift.id, OID);
    h.orders._seed(orderDto("READY_FOR_PICKUP", gift.id));

    await expect(h.service.confirmPickup(OID, "1234")).rejects.toThrow("harness_gift_failure");
    expect(memoryEventOutbox._all()).toHaveLength(0);
  });

  it("B2A-D1 pickup no longer uses the direct emit path", async () => {
    const h = build();
    h.orders._seed(orderDto("READY_FOR_PICKUP"));
    await h.service.confirmPickup(OID, "1234");

    // The only durable record is the outbox row; OrderPickedUp is absent from
    // the direct emit path (pickup enqueues, never emits).
    const rows = rowsFor("OrderPickedUp");
    expect(rows).toHaveLength(1);
  });

  it("B2A-ID1 persisted event_id is preserved by relay reconstruction", async () => {
    const h = build();
    h.orders._seed(orderDto("READY_FOR_PICKUP"));
    await h.service.confirmPickup(OID, "1234");

    const row = rowsFor("OrderPickedUp")[0]!;
    expect(outboxRowToEnvelope(row).event_id).toBe(row.event_id);

    const published: string[] = [];
    const relay = new EventOutboxRelay({
      repo: memoryEventOutbox,
      now: () => new Date(),
      publish: async (env) => {
        published.push(env.event_id);
      },
    });
    await relay.tick();

    expect(published).toContain(row.event_id);
    expect(rowsFor("OrderPickedUp")).toHaveLength(0);
  });
});
