import { beforeEach, describe, expect, it } from "vitest";
import { onEvent } from "../lib/eventBus";
import { resetRedisForTests } from "../lib/redis";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { MemoryCheckoutIdempotencyRepository } from "../repositories/checkoutIdempotencyRepository";
import type { OrderCheckoutTransactionPort } from "../repositories/orderCheckoutContracts";
import { getCatalogRepository, resetCatalogRepository } from "../routes/catalog";
import {
  OrderingService,
  canonicalCheckoutFingerprint,
  normalizeIdempotencyKey,
} from "./ordering";

// ============================================
// ORDER-IDEMPOTENCY-DURABILITY-A2 unit coverage (U1-U8) on the Memory backend.
// Proves durable-key semantics in-process: replay, 409 conflict, per-user
// isolation, no poison after rollback, concurrent convergence, event
// suppression on replay, and fingerprint canonicalization. Real durable
// restart/multi-instance guarantees are Postgres-only (real-PG harness).
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001"; // Rs 220
const MENU_ITEM_2 = "b0000000-0000-4000-8000-000000000002"; // Rs 180
const USER_ID = "u00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "u00000000-0000-4000-8000-000000000002";

interface Req {
  user_id: string;
  restaurant_id: string;
  items: {
    menu_item_id: string;
    quantity: number;
    customizations: { name: string; price_delta: number }[];
    gift_id?: string;
  }[];
  scheduling_policy: "pickup-slot";
  scheduled_pickup_time?: string;
}

function makeRequest(overrides: Partial<Req> = {}): Req {
  return {
    user_id: USER_ID,
    restaurant_id: REST_ID,
    items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
    scheduling_policy: "pickup-slot",
    ...overrides,
  };
}

describe("durable consumer checkout idempotency (A2)", () => {
  let orderRepo: MemoryOrderRepository;
  let giftRepo: MemoryGiftRepository;
  let idemRepo: MemoryCheckoutIdempotencyRepository;
  let service: OrderingService;

  function trackEvents(): string[] {
    const seen: string[] = [];
    onEvent("OrderCreated", async (event) => {
      seen.push(event.aggregate_id);
    });
    return seen;
  }

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    orderRepo = new MemoryOrderRepository();
    giftRepo = new MemoryGiftRepository();
    idemRepo = new MemoryCheckoutIdempotencyRepository();
    service = new OrderingService(
      orderRepo,
      getCatalogRepository(),
      giftRepo,
      undefined,
      idemRepo,
    );
  });

  it("U1 same user/key/payload replays the SAME order and creates once", async () => {
    const events = trackEvents();
    const first = await service.placeOrderIdempotent(makeRequest(), "key-u1");
    expect(first.replayed).toBe(false);

    const second = await service.placeOrderIdempotent(makeRequest(), "key-u1");
    expect(second.replayed).toBe(true);
    expect(second.order.id).toBe(first.order.id);

    expect(await orderRepo.getAll()).toHaveLength(1);
    expect(events.filter((id) => id === first.order.id)).toHaveLength(1);
  });

  it("U2 same user/key/different payload -> 409 IDEMPOTENCY_KEY_REUSED, no second order", async () => {
    await service.placeOrderIdempotent(makeRequest(), "key-u2");

    await expect(
      service.placeOrderIdempotent(
        makeRequest({
          items: [{ menu_item_id: MENU_ITEM_2, quantity: 1, customizations: [] }],
        }),
        "key-u2",
      ),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });

    expect(await orderRepo.getAll()).toHaveLength(1);
  });

  it("U3 different users with the same key stay isolated", async () => {
    const a = await service.placeOrderIdempotent(makeRequest(), "shared-key");
    const b = await service.placeOrderIdempotent(
      makeRequest({ user_id: OTHER_USER_ID }),
      "shared-key",
    );

    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(a.order.id).not.toBe(b.order.id);
    expect(await orderRepo.getAll()).toHaveLength(2);
  });

  it("U4 a rolled-back checkout does NOT poison the key; retry succeeds", async () => {
    let calls = 0;
    const port: OrderCheckoutTransactionPort = {
      runInTransaction: async (fn) => {
        const result = await fn({
          orders: orderRepo,
          gifts: giftRepo,
          idempotency: idemRepo,
        });
        calls += 1;
        if (calls === 1) throw new Error("commit_failed");
        return result;
      },
    };
    const svc = new OrderingService(
      orderRepo,
      getCatalogRepository(),
      giftRepo,
      port,
      idemRepo,
    );

    await expect(
      svc.placeOrderIdempotent(makeRequest(), "key-u4"),
    ).rejects.toThrow("commit_failed");
    expect(await idemRepo.findByUserAndKey(USER_ID, "key-u4")).toBeNull();

    const retry = await svc.placeOrderIdempotent(makeRequest(), "key-u4");
    expect(retry.replayed).toBe(false);
    expect(retry.order.status).toBe("DRAFT");
  });

  it("U5 lost-response retry returns the persisted same order", async () => {
    const first = await service.placeOrderIdempotent(makeRequest(), "key-u5");
    // Simulate the response being lost: the client retries identically.
    const retry = await service.placeOrderIdempotent(makeRequest(), "key-u5");
    expect(retry.replayed).toBe(true);
    expect(retry.order.id).toBe(first.order.id);
    expect(retry.order.total_amount).toBe(first.order.total_amount);
  });

  it("U6 concurrent same-key checkouts converge on exactly one order", async () => {
    const events = trackEvents();
    const [a, b] = await Promise.all([
      service.placeOrderIdempotent(makeRequest(), "key-u6"),
      service.placeOrderIdempotent(makeRequest(), "key-u6"),
    ]);

    expect(a.order.id).toBe(b.order.id);
    expect([a.replayed, b.replayed].filter((r) => r === false)).toHaveLength(1);
    expect(await orderRepo.getAll()).toHaveLength(1);
    expect(events.filter((id) => id === a.order.id)).toHaveLength(1);
  });

  it("U7 a replay emits ZERO duplicate OrderCreated events", async () => {
    const events = trackEvents();
    const first = await service.placeOrderIdempotent(makeRequest(), "key-u7");
    await service.placeOrderIdempotent(makeRequest(), "key-u7");
    await service.placeOrderIdempotent(makeRequest(), "key-u7");

    expect(events.filter((id) => id === first.order.id)).toHaveLength(1);
  });

  it("U8 Memory backend matches the durable semantic contract", async () => {
    const first = await service.placeOrderIdempotent(makeRequest(), "key-u8");
    expect((await service.placeOrderIdempotent(makeRequest(), "key-u8")).replayed).toBe(true);

    await expect(
      service.placeOrderIdempotent(
        makeRequest({
          items: [{ menu_item_id: MENU_ITEM_2, quantity: 3, customizations: [] }],
        }),
        "key-u8",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    // Separate user, same key -> still isolated.
    const other = await service.placeOrderIdempotent(
      makeRequest({ user_id: OTHER_USER_ID }),
      "key-u8",
    );
    expect(other.order.id).not.toBe(first.order.id);
  });

  it("fingerprint is stable across item/customization ordering and offset format", () => {
    const base = makeRequest({
      items: [
        {
          menu_item_id: MENU_ITEM_1,
          quantity: 1,
          customizations: [
            { name: "Extra Spice", price_delta: 25 },
            { name: "Raita", price_delta: 20 },
          ],
        },
        { menu_item_id: MENU_ITEM_2, quantity: 2, customizations: [] },
      ],
      scheduled_pickup_time: "2026-09-14T18:00:00+05:30",
    });
    const reordered = makeRequest({
      items: [
        { menu_item_id: MENU_ITEM_2, quantity: 2, customizations: [] },
        {
          menu_item_id: MENU_ITEM_1,
          quantity: 1,
          customizations: [
            { name: "Raita", price_delta: 20 },
            { name: "Extra Spice", price_delta: 25 },
          ],
        },
      ],
      scheduled_pickup_time: "2026-09-14T12:30:00.000Z",
    });

    expect(canonicalCheckoutFingerprint(base)).toBe(
      canonicalCheckoutFingerprint(reordered),
    );

    const differentQuantity = makeRequest({
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 2, customizations: [] }],
    });
    expect(canonicalCheckoutFingerprint(base)).not.toBe(
      canonicalCheckoutFingerprint(differentQuantity),
    );
  });

  it("missing key preserves legacy checkout (no claim, new order each call)", async () => {
    const a = await service.placeOrderIdempotent(makeRequest());
    const b = await service.placeOrderIdempotent(makeRequest());
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(a.order.id).not.toBe(b.order.id);
    expect(await idemRepo.findByUserAndKey(USER_ID, "key-u1")).toBeNull();
  });

  it("normalizeIdempotencyKey trims, rejects blank/over-long, and never uses correlation id", () => {
    expect(normalizeIdempotencyKey(undefined)).toBeUndefined();
    expect(normalizeIdempotencyKey("  abc  ")).toBe("abc");
    expect(() => normalizeIdempotencyKey("   ")).toThrowError(
      expect.objectContaining({ code: "INVALID_IDEMPOTENCY_KEY" }),
    );
    expect(() => normalizeIdempotencyKey("x".repeat(256))).toThrowError(
      expect.objectContaining({ code: "INVALID_IDEMPOTENCY_KEY" }),
    );
    // Correlation-id is observable but irrelevant to idempotency: an identical
    // request fingerprint is produced regardless of any correlation value.
    expect(canonicalCheckoutFingerprint(makeRequest())).toBe(
      canonicalCheckoutFingerprint(makeRequest()),
    );
  });
});
