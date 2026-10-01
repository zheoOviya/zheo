import type { Express } from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { onEvent } from "../lib/eventBus";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import {
  sharedCheckoutIdempotencyRepo,
  sharedGroupCartRepo,
  sharedIdentityRepo,
  sharedOrderRepo,
  sharedPosOrderRepo,
} from "../repositories/shared";
import { getCatalogRepository, resetCatalogRepository } from "./catalog";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";
import {
  outboxRowToEnvelope,
  type EventOutboxRow,
} from "../repositories/eventOutboxRepository";
import { EventOutboxRelay } from "../services/eventOutboxRelay";
import {
  IDEMPOTENCY_KEY_HEADER,
  OrderingService,
} from "../services/ordering";
import { CateringService } from "../services/catering";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import type { OrderStatus } from "@snakzap/types";
import { MemoryGiftRepository } from "../repositories/giftRepository";

// ============================================
// EVT-B2B-NP1 — producer transactional outbox wiring.
//
// Proves the scoped producers (checkout, POS import, group cart, catering)
// enqueue their events on the SAME commit boundary as the business write and no
// longer direct-emit. MEMORY_MODE = NON_DURABLE_TEST_PARITY: real rollback
// atomicity is proven against PostgreSQL by realPgProducerOutboxBoundary.ts.
// ============================================

const BIRYANI_HOUSE = "a0000000-0000-4000-8000-000000000001";
const CHICKEN_BIRYANI = "b0000000-0000-4000-8000-000000000001";
const VEG_BIRYANI = "b0000000-0000-4000-8000-000000000002";
const CUSTOMER = "00000000-0000-4000-8000-0000000000f1";
const VENDOR = "e0000000-0000-4000-a000-000000000001";
const HOST = "00000000-0000-4000-8000-0000000000f2";
const CONTRIBUTOR = "00000000-0000-4000-8000-0000000000f3";
const POS_ORDER_ID = "pp-np1-order-001";
const FUTURE = "2099-09-01T10:30:00+05:30";

function auth(userId: string, suffix = "0") {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId,
      phone: `+9198765432${suffix}`,
      role: "CONSUMER",
      device_fingerprint: `fp_np1_${userId}`,
    })}`,
  };
}

function vendorAuth() {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: VENDOR,
      phone: "+919876543210",
      role: "VENDOR_OWNER",
      device_fingerprint: "fp_np1_vendor",
    })}`,
  };
}

const rowsFor = (name: string): EventOutboxRow[] =>
  memoryEventOutbox._all().filter((r) => r.event_name === name);

describe("EVT-B2B-NP1 producer transactional outbox", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    memoryEventOutbox._reset();
    sharedOrderRepo._reset();
    sharedGroupCartRepo._reset();
    sharedIdentityRepo._reset();
    sharedPosOrderRepo._reset();
    sharedCheckoutIdempotencyRepo._reset();
    app = createApp();
  });

  // ---------------- Ordering ----------------

  it("NP1-O1 checkout commit enqueues exactly one OrderCreated row", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(CUSTOMER))
      .send({
        restaurant_id: BIRYANI_HOUSE,
        items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 1, customizations: [] }],
      })
      .expect(201);

    const rows = rowsFor("OrderCreated");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(res.body.data.id);
    expect(rows[0]?.status).toBe("PENDING");
  });

  it("NP1-O2 an idempotent replay enqueues no second OrderCreated row", async () => {
    const body = {
      restaurant_id: BIRYANI_HOUSE,
      items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 1, customizations: [] }],
    };
    const first = await request(app)
      .post("/api/v1/orders")
      .set(auth(CUSTOMER))
      .set(IDEMPOTENCY_KEY_HEADER, "np1-key-o2")
      .send(body)
      .expect(201);
    const second = await request(app)
      .post("/api/v1/orders")
      .set(auth(CUSTOMER))
      .set(IDEMPOTENCY_KEY_HEADER, "np1-key-o2")
      .send(body)
      .expect(200);

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(rowsFor("OrderCreated")).toHaveLength(1);
  });

  it("NP1-D1 ordering no longer direct-emits OrderCreated", async () => {
    const seen: unknown[] = [];
    onEvent("OrderCreated", async (evt) => {
      seen.push(evt);
    });

    await request(app)
      .post("/api/v1/orders")
      .set(auth(CUSTOMER))
      .send({
        restaurant_id: BIRYANI_HOUSE,
        items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 1, customizations: [] }],
      })
      .expect(201);

    expect(seen).toHaveLength(0);
    expect(rowsFor("OrderCreated")).toHaveLength(1);
  });

  // ---------------- POS import ----------------

  async function syncMenu() {
    await request(app)
      .post(`/api/vendor/pos/sync-menu?restaurant_id=${BIRYANI_HOUSE}`)
      .set(vendorAuth())
      .expect(200);
  }

  function posPayload() {
    return {
      pos_order_id: POS_ORDER_ID,
      restaurant_id: BIRYANI_HOUSE,
      customer_phone: "919876543210",
      ordered_at: "2026-08-04T10:00:00.000Z",
      items: [
        { pos_item_id: "pp-3001", name: "Mutton Biryani", quantity: 2, price: 260, customizations: [] },
      ],
    };
  }

  it("NP1-P1 POS import enqueues one OrderCreated and one PosOrderImported", async () => {
    await syncMenu();
    await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", "valid_sig_mock")
      .send(posPayload())
      .expect(200);

    expect(rowsFor("OrderCreated")).toHaveLength(1);
    expect(rowsFor("PosOrderImported")).toHaveLength(1);
    expect(rowsFor("OrderCreated")[0]?.aggregate_id).toBe(
      rowsFor("PosOrderImported")[0]?.aggregate_id,
    );
  });

  it("NP1-P2 a duplicate POS import enqueues no additional rows", async () => {
    await syncMenu();
    await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", "valid_sig_mock")
      .send(posPayload())
      .expect(200);
    await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", "valid_sig_mock")
      .send(posPayload())
      .expect(200);

    expect(rowsFor("OrderCreated")).toHaveLength(1);
    expect(rowsFor("PosOrderImported")).toHaveLength(1);
  });

  it("NP1-P3 the inner checkout suppresses its OrderCreated (exactly one row)", async () => {
    await syncMenu();
    await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", "valid_sig_mock")
      .send(posPayload())
      .expect(200);

    const orderCreated = rowsFor("OrderCreated");
    expect(orderCreated).toHaveLength(1);
    expect(orderCreated[0]?.payload).toMatchObject({ order: { status: "DRAFT" } });
  });

  // ---------------- Group cart ----------------

  async function createGroupCart(userId = HOST): Promise<{
    group_cart_token: string;
    order_id: string;
  }> {
    const res = await request(app)
      .post("/api/v1/orders/group/create")
      .set(auth(userId, "1"))
      .send({ restaurant_id: BIRYANI_HOUSE })
      .expect(201);
    return res.body.data;
  }

  it("NP1-G1 group cart creation enqueues one GroupOrderCreated", async () => {
    const cart = await createGroupCart();

    const rows = rowsFor("GroupOrderCreated");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(cart.order_id);
    expect(rows[0]?.payload).toMatchObject({
      order_id: cart.order_id,
      group_cart_token: cart.group_cart_token,
    });
  });

  it("NP1-G2 adding items enqueues one GroupOrderItemAdded per item", async () => {
    const cart = await createGroupCart();
    await request(app)
      .post("/api/v1/orders/group/add")
      .set(auth(CONTRIBUTOR, "2"))
      .send({
        group_cart_token: cart.group_cart_token,
        items: [
          { menu_item_id: CHICKEN_BIRYANI, quantity: 1, customizations: [] },
          { menu_item_id: VEG_BIRYANI, quantity: 2, customizations: [] },
        ],
      })
      .expect(200);

    const rows = rowsFor("GroupOrderItemAdded");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.aggregate_id === cart.order_id)).toBe(true);
  });

  it("NP1-G3 concurrent contributors both persist their events", async () => {
    const cart = await createGroupCart();
    await Promise.all([
      request(app)
        .post("/api/v1/orders/group/add")
        .set(auth(CONTRIBUTOR, "2"))
        .send({
          group_cart_token: cart.group_cart_token,
          items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 1, customizations: [] }],
        })
        .expect(200),
      request(app)
        .post("/api/v1/orders/group/add")
        .set(auth(HOST, "1"))
        .send({
          group_cart_token: cart.group_cart_token,
          items: [{ menu_item_id: VEG_BIRYANI, quantity: 1, customizations: [] }],
        })
        .expect(200),
    ]);

    expect(rowsFor("GroupOrderItemAdded")).toHaveLength(2);
  });

  it("NP1-D2 group + catering no longer direct-emit (G4/C3)", async () => {
    const seen: unknown[] = [];
    onEvent("GroupOrderCreated", async (evt) => {
      seen.push(evt);
    });
    onEvent("CateringOrderCreated", async (evt) => {
      seen.push(evt);
    });

    await createGroupCart();
    await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send({
        restaurant_id: BIRYANI_HOUSE,
        event_date: FUTURE,
        headcount: 150,
        items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 100 }],
      })
      .expect(201);

    expect(seen).toHaveLength(0);
    expect(rowsFor("GroupOrderCreated")).toHaveLength(1);
    expect(rowsFor("CateringOrderCreated")).toHaveLength(1);
  });

  // ---------------- Catering ----------------

  it("NP1-C1 catering enqueues exactly one CateringOrderCreated with CONFIRMED truth", async () => {
    const res = await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send({
        restaurant_id: BIRYANI_HOUSE,
        event_date: FUTURE,
        headcount: 150,
        items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 100 }],
      })
      .expect(201);

    const rows = rowsFor("CateringOrderCreated");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(res.body.data.id);
    expect(rows[0]?.payload).toMatchObject({
      order_id: res.body.data.id,
      headcount: 150,
    });
  });

  // ---------------- ID1: relay reconstruction ----------------

  it("NP1-ID1 persisted event_id survives relay reconstruction", async () => {
    await request(app)
      .post("/api/v1/orders")
      .set(auth(CUSTOMER))
      .send({
        restaurant_id: BIRYANI_HOUSE,
        items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 1, customizations: [] }],
      })
      .expect(201);

    const row = rowsFor("OrderCreated")[0]!;
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
    expect(rowsFor("OrderCreated")).toHaveLength(0);
  });
});

// ============================================
// Service-level edge cases that cannot be reached through the happy-path routes.
// ============================================

class ForceCasMissOrderRepo extends MemoryOrderRepository {
  override async transitionStatus(
    _orderId: string,
    _from: OrderStatus,
    _to: OrderStatus,
  ): Promise<null> {
    return null;
  }
}

describe("EVT-B2B-NP1 producer outbox edge cases", () => {
  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    memoryEventOutbox._reset();
  });

  it("NP1-O3 a lost gift CAS enqueues zero OrderCreated rows", async () => {
    const orderRepo = new MemoryOrderRepository();
    const giftRepo = new MemoryGiftRepository();
    const catalog = getCatalogRepository();
    const service = new OrderingService(orderRepo, catalog, giftRepo);

    const gift = await giftRepo.create({
      sender_id: "00000000-0000-4000-8000-0000000000aa",
      restaurant_id: BIRYANI_HOUSE,
      menu_item_id: CHICKEN_BIRYANI,
      item_snapshot: {
        name: "Chicken Biryani",
        price: 220,
        image_url: null,
        dietary_tags: {},
        spice_level: 0,
        customizations: [],
      },
      price_paid: 220,
      message: null,
      recipient_name: null,
      claim_token: randomUUID(),
      claim_code: "NP1C2",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await giftRepo.markPaid(gift.id);
    await giftRepo.markClaimed(gift.id, CUSTOMER);
    // Pre-bind to another order so the checkout's CAS loses.
    await giftRepo.bindToOrder(gift.id, randomUUID());

    await expect(
      service.placeOrder({
        user_id: CUSTOMER,
        restaurant_id: BIRYANI_HOUSE,
        items: [
          { menu_item_id: CHICKEN_BIRYANI, quantity: 1, customizations: [], gift_id: gift.id },
        ],
      }),
    ).rejects.toMatchObject({ code: "GIFT_ALREADY_REDEEMED" });

    expect(rowsFor("OrderCreated")).toHaveLength(0);
  });

  it("NP1-C2 a catering CAS miss enqueues zero CateringOrderCreated rows", async () => {
    const orderRepo = new ForceCasMissOrderRepo();
    const service = new CateringService(orderRepo, getCatalogRepository());

    await expect(
      service.placeCateringOrder({
        user_id: CUSTOMER,
        restaurant_id: BIRYANI_HOUSE,
        event_date: FUTURE,
        headcount: 150,
        items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 100 }],
      }),
    ).rejects.toMatchObject({ code: "CATERING_CONFIRM_FAILED" });

    expect(rowsFor("CateringOrderCreated")).toHaveLength(0);
  });

  it("NP1-C3 a catering success writes one row and no direct emit", async () => {
    const orderRepo = new MemoryOrderRepository();
    const service = new CateringService(orderRepo, getCatalogRepository());

    const seen: unknown[] = [];
    onEvent("CateringOrderCreated", async (evt) => {
      seen.push(evt);
    });

    const order = await service.placeCateringOrder({
      user_id: CUSTOMER,
      restaurant_id: BIRYANI_HOUSE,
      event_date: FUTURE,
      headcount: 150,
      items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 100 }],
    });

    expect(order.status).toBe("CONFIRMED");
    expect(rowsFor("CateringOrderCreated")).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });
});
