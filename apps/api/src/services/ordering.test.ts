import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../lib/dbType";
import { onEvent } from "../lib/eventBus";
import { resetRedisForTests } from "../lib/redis";
import type { CreateOrderInput } from "../repositories/orderRepository";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import {
  MemoryOrderCheckoutTransactionPort,
  type OrderCheckoutTransactionPort,
  type OrderCheckoutTxRepos,
} from "../repositories/orderCheckoutContracts";
import {
  DrizzleOrderCheckoutTransactionPort,
  selectOrderCheckoutTransactionPort,
} from "../repositories/drizzle/orderCheckoutTransactionPort";
import { DrizzleOrderRepository } from "../repositories/drizzle/drizzleOrderRepository";
import { DrizzleGiftRepository } from "../repositories/drizzle/drizzleGiftRepository";
import { getCatalogRepository, resetCatalogRepository } from "../routes/catalog";
import { OrderingService } from "./ordering";
import { calculatePriceBreakdown } from "./pricing";

// ============================================
// ORDER-AGGREGATE-IDEMPOTENCY-A3 unit coverage (U1-U6).
//
// Verifies that consumer checkout places the order row, every order item, and
// each gift CAS bind on ONE transaction callback, that events are emitted only
// after the callback resolves, and that the memory passthrough makes no
// atomicity claim (real atomicity is Postgres-only, proven by the real-PG
// harness).
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001";
const USER_ID = "u00000000-0000-4000-8000-000000000001";

function buildInput(): CreateOrderInput {
  const orderItems = [
    {
      menu_item_id: MENU_ITEM_1,
      name: "Chicken Biryani",
      base_price: 220,
      quantity: 1,
      customizations: [],
    },
  ];
  const breakdown = calculatePriceBreakdown(orderItems);
  return {
    user_id: USER_ID,
    restaurant_id: REST_ID,
    items: orderItems.map((item) => ({
      ...item,
      gift_id: null,
      customization_total:
        breakdown.items.find((b) => b.menu_item_id === item.menu_item_id)
          ?.customization_total ?? 0,
      item_subtotal:
        breakdown.items.find((b) => b.menu_item_id === item.menu_item_id)
          ?.item_subtotal ?? 0,
    })),
    breakdown,
  };
}

async function seedClaimedGift(giftRepo: MemoryGiftRepository): Promise<string> {
  const gift = await giftRepo.create({
    sender_id: "u00000000-0000-4000-8000-0000000000aa",
    restaurant_id: REST_ID,
    menu_item_id: MENU_ITEM_1,
    item_snapshot: {
      name: "Chicken Biryani",
      price: 220,
      image_url: null,
      dietary_tags: { NON_VEG: true },
      spice_level: 5,
      customizations: [],
    },
    price_paid: 220,
    message: null,
    recipient_name: null,
    claim_token: `tok-${Math.random().toString(36).slice(2)}`,
    claim_code: "TEST12",
    expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
  });
  await giftRepo.markPaid(gift.id);
  await giftRepo.markClaimed(gift.id, USER_ID);
  return gift.id;
}

describe("OrderingService consumer checkout atomicity (A3)", () => {
  let orderRepo: MemoryOrderRepository;
  let giftRepo: MemoryGiftRepository;
  let service: OrderingService;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    orderRepo = new MemoryOrderRepository();
    giftRepo = new MemoryGiftRepository();
    service = new OrderingService(orderRepo, getCatalogRepository(), giftRepo);
  });

  it("U1 places the order, its items, and the gift bind in one transaction then emits once", async () => {
    const giftId = await seedClaimedGift(giftRepo);
    const seen: string[] = [];
    onEvent("OrderCreated", async () => {
      seen.push("OrderCreated");
    });

    let txCalls = 0;
    const port: OrderCheckoutTransactionPort = {
      runInTransaction: (fn) => {
        txCalls += 1;
        return fn({ orders: orderRepo, gifts: giftRepo });
      },
    };
    service = new OrderingService(
      orderRepo,
      getCatalogRepository(),
      giftRepo,
      port,
    );

    const order = await service.placeOrder({
      user_id: USER_ID,
      restaurant_id: REST_ID,
      items: [
        {
          menu_item_id: MENU_ITEM_1,
          quantity: 1,
          customizations: [],
          gift_id: giftId,
        },
      ],
    });

    expect(txCalls).toBe(1);
    const persisted = await orderRepo.getById(order.id);
    expect(persisted?.items).toHaveLength(1);
    expect(persisted?.status).toBe("DRAFT");
    const bound = await giftRepo.getById(giftId);
    expect(bound?.redeemed_order_id).toBe(order.id);
    expect(seen).toEqual(["OrderCreated"]);
  });

  it("U2 a lost gift CAS rejects with GIFT_ALREADY_REDEEMED, emits nothing, and retires the order", async () => {
    const giftId = await seedClaimedGift(giftRepo);
    const seen: string[] = [];
    onEvent("OrderCreated", async () => {
      seen.push("OrderCreated");
    });

    const port: OrderCheckoutTransactionPort = {
      runInTransaction: (fn) =>
        fn({
          orders: orderRepo,
          gifts: {
            bindToOrder: async () => null,
            releaseFromOrder: async () => null,
          },
        }),
    };
    service = new OrderingService(
      orderRepo,
      getCatalogRepository(),
      giftRepo,
      port,
    );

    await expect(
      service.placeOrder({
        user_id: USER_ID,
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
            gift_id: giftId,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "GIFT_ALREADY_REDEEMED" });

    expect(seen).toEqual([]);
    const orders = await orderRepo.getAll();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe("CANCELLED");
  });

  it("U3 a transaction failure rejects and emits zero OrderCreated events", async () => {
    const seen: string[] = [];
    onEvent("OrderCreated", async () => {
      seen.push("OrderCreated");
    });

    const port: OrderCheckoutTransactionPort = {
      runInTransaction: async (fn) => {
        await fn({ orders: orderRepo, gifts: giftRepo });
        throw new Error("commit_failed");
      },
    };
    service = new OrderingService(
      orderRepo,
      getCatalogRepository(),
      giftRepo,
      port,
    );

    await expect(
      service.placeOrder({
        user_id: USER_ID,
        restaurant_id: REST_ID,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
      }),
    ).rejects.toThrow("commit_failed");

    expect(seen).toEqual([]);
  });

  it("U4 places a gift-free order and emits exactly one OrderCreated", async () => {
    const seen: string[] = [];
    onEvent("OrderCreated", async () => {
      seen.push("OrderCreated");
    });

    const order = await service.placeOrder({
      user_id: USER_ID,
      restaurant_id: REST_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 2, customizations: [] }],
    });

    expect(order.status).toBe("DRAFT");
    expect(order.items).toHaveLength(1);
    expect(order.items[0]?.quantity).toBe(2);
    expect(seen).toEqual(["OrderCreated"]);
  });

  it("U5 the memory port is an explicit passthrough with no rollback guarantee", async () => {
    const port = new MemoryOrderCheckoutTransactionPort(() => ({
      orders: orderRepo,
      gifts: giftRepo,
    }));

    const created = await orderRepo.create(buildInput());
    await expect(
      port.runInTransaction(async () => {
        await orderRepo.updateStatus(created.id, "CANCELLED");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // No rollback: the mutation survives the throw (MEMORY_ROLLBACK_PROVEN: NO).
    expect((await orderRepo.getById(created.id))?.status).toBe("CANCELLED");
  });

  it("U6 the selector passes through memory repos and the Drizzle port builds tx-scoped repos", async () => {
    const port = selectOrderCheckoutTransactionPort(orderRepo, giftRepo);
    expect(port).toBeInstanceOf(MemoryOrderCheckoutTransactionPort);

    let observed: OrderCheckoutTxRepos | null = null;
    await port.runInTransaction(async (repos) => {
      observed = repos;
    });
    expect(observed).not.toBeNull();
    expect(observed!.orders).toBe(orderRepo);
    expect(observed!.gifts).toBe(giftRepo);

    const txHandle = {};
    const transaction = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(txHandle),
    );
    const drizzlePort = new DrizzleOrderCheckoutTransactionPort({
      transaction,
    } as unknown as DrizzleDb);

    const drizzleRepos = await drizzlePort.runInTransaction(
      async (repos) => repos,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(drizzleRepos.orders).toBeInstanceOf(DrizzleOrderRepository);
    expect(drizzleRepos.gifts).toBeInstanceOf(DrizzleGiftRepository);
  });
});
