import type { Express } from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { onEvent } from "../lib/eventBus";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { getCatalogRepository, resetCatalogRepository } from "./catalog";
import {
  sharedIdentityRepo,
  sharedOrderRepo,
  sharedPosOrderRepo,
} from "../repositories/shared";
import {
  isPosOrderMappingDuplicate,
  MemoryPosOrderRepository,
  POS_ORDER_MAPPING_UNIQUE_CONSTRAINT,
  type PosImportTxRepos,
  type PosOrderRepository,
} from "../repositories/posRepository";
import { OrderingService } from "../services/ordering";
import { PetpoojaPosService } from "../services/posPetpooja";

// ============================================
// Petpooja POS integration (V01) route tests
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner

function vendorAuthHeaders(userId?: string, role?: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId ?? OWNER_ID,
      phone: "+919876543210",
      role: role ?? "VENDOR_OWNER",
      device_fingerprint: "fp_test_device_abc1234",
    })}`,
  };
}

const POS_ORDER_ID = "pp-order-20260804-001";

function buildPayload(overrides: Record<string, unknown> = {}): {
  payload: Record<string, unknown>;
  signature: string;
} {
  const payload = {
    pos_order_id: POS_ORDER_ID,
    restaurant_id: REST_ID,
    customer_phone: "919876543210",
    ordered_at: "2026-08-04T10:00:00.000Z",
    items: [
      { pos_item_id: "pp-3001", name: "Mutton Biryani", quantity: 2, price: 260, customizations: [] },
      { pos_item_id: "pp-4001", name: "Gobi Manchurian", quantity: 1, price: 150, customizations: [] },
    ],
    ...overrides,
  };
  return { payload, signature: "valid_sig_mock" };
}

describe("Petpooja POS webhook", () => {
  let app: Express;

  beforeEach(async () => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedPosOrderRepo._reset();
    sharedIdentityRepo._reset();
    app = createApp();

    // Every test starts with a synced POS menu so items resolve.
    await request(app)
      .post(`/api/vendor/pos/sync-menu?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);
  });

  it("imports a signed POS order straight to CONFIRMED", async () => {
    const { payload, signature } = buildPayload();

    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.processed).toBe(true);
    expect(res.body.data.idempotent).toBe(false);
    expect(res.body.data.order_status).toBe("CONFIRMED");
    expect(res.body.data.order_id).toBeTruthy();

    const order = await sharedOrderRepo.getById(res.body.data.order_id);
    expect(order?.status).toBe("CONFIRMED");
    expect(order?.total_amount).toBeGreaterThan(0);
  });

  it("imports a long-past ordered_at under the default scheduling policy", async () => {
    // POS `ordered_at` is a provider-created timestamp, not a consumer pickup
    // slot. The default "none" policy must store it verbatim without running
    // it through the pickup-slot calendar (which would reject a past instant).
    const { payload, signature } = buildPayload({
      ordered_at: "2020-01-01T10:00:00.000Z",
    });

    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);

    expect(res.body.data.order_status).toBe("CONFIRMED");
    const order = await sharedOrderRepo.getById(res.body.data.order_id);
    expect(order?.scheduled_pickup_time).toBe("2020-01-01T10:00:00.000Z");
  });

  it("is idempotent: a retried pos_order_id never creates a second order", async () => {
    const { payload, signature } = buildPayload();

    const first = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);
    expect(first.body.data.processed).toBe(true);

    const second = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);
    expect(second.body.data.processed).toBe(false);
    expect(second.body.data.idempotent).toBe(true);
    expect(second.body.data.order_id).toBe(first.body.data.order_id);

    const orders = await sharedOrderRepo.getByRestaurant(REST_ID);
    expect(orders).toHaveLength(1);
  });

  it("rejects a missing or invalid signature with 401", async () => {
    const { payload } = buildPayload();

    await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .send(payload)
      .expect(401);

    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", "tampered")
      .send(payload)
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_WEBHOOK_SIGNATURE");
  });

  it("rejects a malformed payload with 400", async () => {
    const { signature } = buildPayload();
    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send({ pos_order_id: POS_ORDER_ID, items: [] })
      .expect(400);
    expect(res.body.error.code).toBe("INVALID_WEBHOOK");
  });

  it("rejects items that have not been synced into the menu", async () => {
    const { payload, signature } = buildPayload({
      items: [{ pos_item_id: "pp-9999", name: "Unknown Dish", quantity: 1, price: 10, customizations: [] }],
    });
    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(400);
    expect(res.body.error.code).toBe("POS_ITEM_NOT_SYNCED");
  });

  it("keys the customer on phone so POS and web orders share a user_id", async () => {
    const { payload, signature } = buildPayload();
    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);

    const order = await sharedOrderRepo.getById(res.body.data.order_id);
    const user = await sharedIdentityRepo.getByPhone("919876543210");
    expect(user).not.toBeNull();
    expect(order?.user_id).toBe(user?.id);

    // A second order from the same phone reuses the same user.
    const second = buildPayload({ pos_order_id: "pp-order-2" });
    const res2 = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", second.signature)
      .send(second.payload)
      .expect(200);
    const order2 = await sharedOrderRepo.getById(res2.body.data.order_id);
    expect(order2?.user_id).toBe(user?.id);
  });

  it("menu sync converges: a second sync never duplicates POS items", async () => {
    const repo = getCatalogRepository();
    const posItems = (items: { pos_item_id: string | null }[]) =>
      items.filter((i) => i.pos_item_id !== null).length;

    const afterFirst = posItems(await repo.getMenuAll(REST_ID));

    await request(app)
      .post(`/api/vendor/pos/sync-menu?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);
    const afterSecond = posItems(await repo.getMenuAll(REST_ID));

    expect(afterFirst).toBe(4);
    expect(afterSecond).toBe(4);
  });

  it("simulate-order syncs and imports an order end to end", async () => {
    const res = await request(app)
      .post(`/api/vendor/pos/simulate-order?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);

    expect(res.body.data.menu_synced).toBe(4);
    expect(res.body.data.import.processed).toBe(true);
    expect(res.body.data.import.order_status).toBe("CONFIRMED");

    const order = await sharedOrderRepo.getById(res.body.data.import.order_id);
    expect(order).not.toBeNull();
    expect(order?.restaurant_id).toBe(REST_ID);
  });

  it("resolves the default restaurant before precheck and scopes the mapping to it", async () => {
    // No restaurant_id in the payload -> config default (== REST_ID) must be
    // resolved and used for BOTH the precheck and the stored mapping.
    const { payload, signature } = buildPayload({ restaurant_id: undefined });

    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);

    expect(res.body.data.processed).toBe(true);
    const mapping = await sharedPosOrderRepo.getByPosOrderId(
      REST_ID,
      POS_ORDER_ID,
    );
    expect(mapping?.order_id).toBe(res.body.data.order_id);
  });

  it("keys the POS mapping by restaurant: same pos id in two restaurants never collides", async () => {
    const repo = new MemoryPosOrderRepository();
    const r1 = "11111111-1111-4111-8111-111111111111";
    const r2 = "22222222-2222-4222-8222-222222222222";
    const SHARED_POS_ID = "shared-pos-id-1";

    const a = await repo.recordOrder(r1, SHARED_POS_ID, "order-a");
    const b = await repo.recordOrder(r2, SHARED_POS_ID, "order-b");

    expect(a.order_id).toBe("order-a");
    expect(b.order_id).toBe("order-b");
    expect((await repo.getByPosOrderId(r1, SHARED_POS_ID))?.order_id).toBe(
      "order-a",
    );
    expect((await repo.getByPosOrderId(r2, SHARED_POS_ID))?.order_id).toBe(
      "order-b",
    );
    // Restaurant-scoped: an unknown pair is a miss even though the pos id exists.
    expect(await repo.getByPosOrderId(r1, "unknown-pos-id")).toBeNull();
  });

  it("normal OrderingService default still emits OrderCreated", async () => {
    const seen: string[] = [];
    onEvent("OrderCreated", async () => {
      seen.push("OrderCreated");
    });

    const catalog = getCatalogRepository();
    const menu = (await catalog.getMenuAll(REST_ID)).filter(
      (m) => m.is_available,
    );
    const firstMenuItem = menu[0];
    if (!firstMenuItem) throw new Error("expected a synced menu item");
    const service = new OrderingService(sharedOrderRepo, catalog);
    const order = await service.placeOrder({
      user_id: OWNER_ID,
      restaurant_id: REST_ID,
      items: [
        { menu_item_id: firstMenuItem.id, quantity: 1, customizations: [] },
      ],
    });

    expect(order.id).toBeTruthy();
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  it("POS path suppresses the in-transaction OrderCreated (emits it only post-commit)", async () => {
    let insideTransaction = false;
    let orderCreatedInsideTx = false;
    onEvent("OrderCreated", async () => {
      if (insideTransaction) orderCreatedInsideTx = true;
    });

    const fake: PosOrderRepository = {
      recordOrder: async (restaurantId, posOrderId, orderId) => ({
        id: randomUUID(),
        pos_order_id: posOrderId,
        order_id: orderId,
        restaurant_id: restaurantId,
        created_at: new Date().toISOString(),
      }),
      getByPosOrderId: async () => null,
      transactionPort: () => ({
        runInTransaction: async <T,>(
          fn: (repos: PosImportTxRepos) => Promise<T>,
        ): Promise<T> => {
          insideTransaction = true;
          try {
            return await fn({ orders: sharedOrderRepo, pos: fake });
          } finally {
            insideTransaction = false;
          }
        },
      }),
      _reset: () => {},
    };

    const service = new PetpoojaPosService(
      sharedOrderRepo,
      getCatalogRepository(),
      sharedIdentityRepo,
      fake,
    );
    const { payload, signature } = buildPayload();
    const result = await service.processOrderWebhook(
      JSON.stringify(payload),
      signature,
    );

    expect(result.processed).toBe(true);
    expect(orderCreatedInsideTx).toBe(false);
  });

  it("treats ONLY the exact POS mapping constraint as the idempotency violation", () => {
    expect(
      isPosOrderMappingDuplicate({
        code: "23505",
        constraint: POS_ORDER_MAPPING_UNIQUE_CONSTRAINT,
      }),
    ).toBe(true);
    // Wrapped cause chain is inspected.
    expect(
      isPosOrderMappingDuplicate({
        cause: {
          code: "23505",
          constraint: POS_ORDER_MAPPING_UNIQUE_CONSTRAINT,
        },
      }),
    ).toBe(true);
    // Unrelated 23505 must not be swallowed.
    expect(
      isPosOrderMappingDuplicate({ code: "23505", constraint: "some_other_uq" }),
    ).toBe(false);
    expect(
      isPosOrderMappingDuplicate({
        code: "23503",
        constraint: POS_ORDER_MAPPING_UNIQUE_CONSTRAINT,
      }),
    ).toBe(false);
    expect(isPosOrderMappingDuplicate(new Error("boom"))).toBe(false);
  });

  it("rethrows unrelated duplicates and resolves the exact duplicate race", async () => {
    const buildFake = (
      transactionPort: PosOrderRepository["transactionPort"],
      getByPosOrderId: PosOrderRepository["getByPosOrderId"],
    ): PosOrderRepository => ({
      recordOrder: async (restaurantId, posOrderId, orderId) => ({
        id: randomUUID(),
        pos_order_id: posOrderId,
        order_id: orderId,
        restaurant_id: restaurantId,
        created_at: new Date().toISOString(),
      }),
      getByPosOrderId,
      transactionPort,
      _reset: () => {},
    });

    // Unrelated 23505 from the transaction must propagate untouched.
    const unrelated = new PetpoojaPosService(
      sharedOrderRepo,
      getCatalogRepository(),
      sharedIdentityRepo,
      buildFake(
        () => ({
          runInTransaction: async () => {
            throw { code: "23505", constraint: "some_other_uq" };
          },
        }),
        async () => null,
      ),
    );
    const unrelatedPayload = buildPayload({ pos_order_id: "pp-unrelated" });
    await expect(
      unrelated.processOrderWebhook(
        JSON.stringify(unrelatedPayload.payload),
        unrelatedPayload.signature,
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "some_other_uq" });

    // Exact duplicate: precheck misses, tx loses the race, reread finds the
    // winner -> idempotent, no events (the winner already emitted).
    const winner = {
      id: "winner-mapping",
      pos_order_id: "pp-race",
      order_id: "winner-order",
      restaurant_id: REST_ID,
      created_at: new Date().toISOString(),
    };
    let reads = 0;
    const raced = new PetpoojaPosService(
      sharedOrderRepo,
      getCatalogRepository(),
      sharedIdentityRepo,
      buildFake(
        () => ({
          runInTransaction: async () => {
            throw {
              code: "23505",
              constraint: POS_ORDER_MAPPING_UNIQUE_CONSTRAINT,
            };
          },
        }),
        async (_restaurantId, posOrderId) => {
          if (posOrderId !== "pp-race") return null;
          reads += 1;
          return reads >= 2 ? winner : null;
        },
      ),
    );
    const racePayload = buildPayload({ pos_order_id: "pp-race" });
    const raceResult = await raced.processOrderWebhook(
      JSON.stringify(racePayload.payload),
      racePayload.signature,
    );
    expect(raceResult).toEqual({
      processed: false,
      idempotent: true,
      order_id: "winner-order",
    });

    // Exact duplicate but the winner is unreadable -> explicit failure, never a
    // fabricated success.
    const unresolved = new PetpoojaPosService(
      sharedOrderRepo,
      getCatalogRepository(),
      sharedIdentityRepo,
      buildFake(
        () => ({
          runInTransaction: async () => {
            throw {
              code: "23505",
              constraint: POS_ORDER_MAPPING_UNIQUE_CONSTRAINT,
            };
          },
        }),
        async () => null,
      ),
    );
    const missingPayload = buildPayload({ pos_order_id: "pp-missing" });
    await expect(
      unresolved.processOrderWebhook(
        JSON.stringify(missingPayload.payload),
        missingPayload.signature,
      ),
    ).rejects.toMatchObject({ code: "POS_IMPORT_CONFLICT_UNRESOLVED" });
  });
});
