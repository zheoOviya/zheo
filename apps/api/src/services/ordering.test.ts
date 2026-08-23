import { describe, expect, it, beforeEach } from "vitest";
import type {
  MenuItemDTO,
  RestaurantDTO,
} from "../repositories/catalogRepository";
import { MemoryCatalogRepository } from "../repositories/catalogRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import {
  MemoryOrderRepository,
  type OrderDTO,
} from "../repositories/orderRepository";
import { OrderingService, type PlaceOrderRequest } from "./ordering";
import type { CustomizationDelta } from "./pricing";

// ============================================
// Task 2 (server-authoritative customization pricing) regression suite.
//
// The server must resolve every customization price from the catalog item's
// own `customizations`, NEVER from the client-supplied `price_delta`.
// Money-path assertions read the PERSISTED order back from the repository,
// not just the create() response.
// ============================================

const RESTAURANT: RestaurantDTO = {
  id: "r1",
  name: "Test Kitchen",
  gst_number: null,
  owner_id: "o1",
  commission_rate: 0.08,
  is_active: true,
  lat: null,
  lng: null,
  pickup_eta_min: 10,
  rating: null,
  cuisines: [],
  price_for_one: null,
  cover_image: null,
};

const MENU: MenuItemDTO[] = [
  {
    id: "m-cheese",
    restaurant_id: "r1",
    name: "Burger",
    price: 100,
    description: null,
    dietary_tags: {},
    customizations: [{ name: "Extra Cheese", price_delta: 30 }],
    image_url: null,
    pos_item_id: null,
    is_available: true,
    spice_level: 1,
  },
  {
    id: "m-free",
    restaurant_id: "r1",
    name: "Freebie",
    price: 50,
    description: null,
    dietary_tags: {},
    customizations: [{ name: "Extra Onion", price_delta: 0 }],
    image_url: null,
    pos_item_id: null,
    is_available: true,
    spice_level: 1,
  },
  {
    id: "m-dup",
    restaurant_id: "r1",
    name: "Dup Burger",
    price: 100,
    description: null,
    dietary_tags: {},
    customizations: [
      { name: "Double", price_delta: 1 },
      { name: "Double", price_delta: 2 },
    ],
    image_url: null,
    pos_item_id: null,
    is_available: true,
    spice_level: 1,
  },
  {
    id: "m-mal",
    restaurant_id: "r1",
    name: "Broken Burger",
    price: 100,
    description: null,
    dietary_tags: {},
    customizations: [{ name: "Broken", price_delta: "oops" }],
    image_url: null,
    pos_item_id: null,
    is_available: true,
    spice_level: 1,
  },
  {
    id: "m-neg",
    restaurant_id: "r1",
    name: "Discount Burger",
    price: 100,
    description: null,
    dietary_tags: {},
    customizations: [{ name: "Discount", price_delta: -10 }],
    image_url: null,
    pos_item_id: null,
    is_available: true,
    spice_level: 1,
  },
  {
    id: "m-negbase",
    restaurant_id: "r1",
    name: "Freebie Overflow",
    price: -12,
    description: null,
    dietary_tags: {},
    customizations: [],
    image_url: null,
    pos_item_id: null,
    is_available: true,
    spice_level: 1,
  },
];

describe("OrderingService server-authoritative customization pricing", () => {
  let orderRepo: MemoryOrderRepository;
  let giftRepo: MemoryGiftRepository;
  let service: OrderingService;

  beforeEach(() => {
    orderRepo = new MemoryOrderRepository();
    giftRepo = new MemoryGiftRepository();
    service = new OrderingService(
      orderRepo,
      new MemoryCatalogRepository([RESTAURANT], MENU),
      giftRepo,
    );
  });

  function request(
    item: { menu_item_id: string; quantity: number; customizations: CustomizationDelta[]; gift_id?: string },
  ): PlaceOrderRequest {
    return {
      user_id: "u1",
      restaurant_id: "r1",
      items: [item],
    };
  }

  async function persisted(orderId: string): Promise<OrderDTO> {
    const order = await orderRepo.getById(orderId);
    if (!order) throw new Error(`order ${orderId} not persisted`);
    return order;
  }

  it("uses the catalog price and ignores a forged negative client delta", async () => {
    const order = await service.placeOrder(
      request({
        menu_item_id: "m-cheese",
        quantity: 1,
        customizations: [{ name: "Extra Cheese", price_delta: -499 }],
      }),
    );

    const saved = await persisted(order.id);
    expect(saved.items[0]!.customizations).toEqual([
      { name: "Extra Cheese", price_delta: 30 },
    ]);
    expect(saved.items[0]!.customization_total).toBe(30);
    expect(saved.items[0]!.item_subtotal).toBe(130);
    expect(saved.total_amount).toBe(148.3);
  });

  it("ignores a forged small positive client delta", async () => {
    const order = await service.placeOrder(
      request({
        menu_item_id: "m-cheese",
        quantity: 2,
        customizations: [{ name: "Extra Cheese", price_delta: 1 }],
      }),
    );

    const saved = await persisted(order.id);
    expect(saved.items[0]!.customization_total).toBe(30);
    expect(saved.items[0]!.item_subtotal).toBe(260);
    expect(saved.total_amount).toBe(296.6);
  });

  it("ignores a forged huge client delta", async () => {
    const order = await service.placeOrder(
      request({
        menu_item_id: "m-cheese",
        quantity: 1,
        customizations: [{ name: "Extra Cheese", price_delta: 999999 }],
      }),
    );

    const saved = await persisted(order.id);
    expect(saved.items[0]!.customization_total).toBe(30);
    expect(saved.items[0]!.item_subtotal).toBe(130);
    expect(saved.total_amount).toBe(148.3);
  });

  it("rejects a customization name the catalog does not offer", async () => {
    await expect(
      service.placeOrder(
        request({
          menu_item_id: "m-cheese",
          quantity: 1,
          customizations: [{ name: "Not On Menu", price_delta: 5 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CUSTOMIZATION", status: 400 });
  });

  it("rejects a customization name requested more than once", async () => {
    await expect(
      service.placeOrder(
        request({
          menu_item_id: "m-cheese",
          quantity: 1,
          customizations: [
            { name: "Extra Cheese", price_delta: 30 },
            { name: "Extra Cheese", price_delta: 30 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CUSTOMIZATION", status: 400 });
  });

  it("fails closed on a malformed catalog customization entry", async () => {
    await expect(
      service.placeOrder(
        request({
          menu_item_id: "m-mal",
          quantity: 1,
          customizations: [{ name: "Broken", price_delta: 0 }],
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CATALOG_CUSTOMIZATION",
      status: 500,
    });
  });

  it("rejects a negative catalog price delta as malformed configuration", async () => {
    await expect(
      service.placeOrder(
        request({
          menu_item_id: "m-neg",
          quantity: 1,
          customizations: [{ name: "Discount", price_delta: 0 }],
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CATALOG_CUSTOMIZATION",
      status: 500,
    });
  });

  it("rejects an ambiguous catalog that defines a customization twice", async () => {
    await expect(
      service.placeOrder(
        request({
          menu_item_id: "m-dup",
          quantity: 1,
          customizations: [{ name: "Double", price_delta: 0 }],
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CATALOG_CUSTOMIZATION",
      status: 500,
    });
  });

  it("accepts a free catalog customization (delta 0)", async () => {
    const order = await service.placeOrder(
      request({
        menu_item_id: "m-free",
        quantity: 1,
        customizations: [{ name: "Extra Onion", price_delta: 999 }],
      }),
    );

    const saved = await persisted(order.id);
    expect(saved.items[0]!.customizations).toEqual([
      { name: "Extra Onion", price_delta: 0 },
    ]);
    expect(saved.items[0]!.customization_total).toBe(0);
    expect(saved.items[0]!.item_subtotal).toBe(50);
    expect(saved.total_amount).toBe(64.3);
  });

  it("rejects an order whose server-computed total is not positive", async () => {
    await expect(
      service.placeOrder(
        request({
          menu_item_id: "m-negbase",
          quantity: 1,
          customizations: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ORDER_AMOUNT", status: 400 });
  });

  it("places a no-customization order unchanged", async () => {
    const order = await service.placeOrder(
      request({ menu_item_id: "m-cheese", quantity: 1, customizations: [] }),
    );

    const saved = await persisted(order.id);
    expect(saved.items[0]!.customization_total).toBe(0);
    expect(saved.items[0]!.item_subtotal).toBe(100);
    expect(saved.total_amount).toBe(116.8);
  });

  it("reorder resolves stored customization names against the current catalog", async () => {
    const now = new Date().toISOString();
    orderRepo._seed({
      id: "poisoned-order",
      user_id: "u-old",
      restaurant_id: "r1",
      items: [
        {
          id: "oi-poisoned",
          menu_item_id: "m-cheese",
          name: "Burger",
          base_price: 100,
          quantity: 1,
          customizations: [{ name: "Extra Cheese", price_delta: -499 }],
          customization_total: -499,
          item_subtotal: -399,
          gift_id: null,
        },
      ],
      total_amount: -407.15,
      status: "CONFIRMED",
      commission_rate: 0,
      commission_amount: 0,
      pickup_otp: null,
      qr_token: null,
      checked_in: false,
      scheduled_pickup_time: null,
      created_at: now,
      updated_at: now,
    });

    const order = await service.reorder("u2", "poisoned-order");
    const saved = await persisted(order.id);
    expect(saved.items[0]!.customizations).toEqual([
      { name: "Extra Cheese", price_delta: 30 },
    ]);
    expect(saved.items[0]!.customization_total).toBe(30);
    expect(saved.items[0]!.item_subtotal).toBe(130);
    expect(saved.total_amount).toBe(148.3);
  });

  it("keeps the gift branch at zero cost for the recipient", async () => {
    const gift = await giftRepo.create({
      sender_id: "u-sender",
      restaurant_id: "r1",
      menu_item_id: "m-cheese",
      item_snapshot: {
        name: "Burger",
        price: 100,
        image_url: null,
        dietary_tags: {},
        spice_level: 1,
        customizations: [{ name: "Extra Cheese", price_delta: 30 }],
      },
      price_paid: 130,
      message: null,
      recipient_name: null,
      claim_token: "gift-tok-1",
      claim_code: "123456",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await giftRepo.updateStatus(gift.id, "ACTIVE");
    await giftRepo.markClaimed(gift.id, "u2");

    const order = await service.placeOrder({
      user_id: "u2",
      restaurant_id: "r1",
      items: [
        {
          menu_item_id: "m-cheese",
          quantity: 1,
          customizations: [{ name: "Extra Cheese", price_delta: -499 }],
          gift_id: gift.id,
        },
      ],
    });

    const saved = await persisted(order.id);
    expect(saved.items[0]!.base_price).toBe(0);
    expect(saved.items[0]!.customizations).toEqual([
      { name: "Extra Cheese", price_delta: 0 },
    ]);
    expect(saved.items[0]!.customization_total).toBe(0);
  });
});
