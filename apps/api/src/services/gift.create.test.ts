import { describe, expect, it, beforeEach } from "vitest";
import { GiftService } from "./gift";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import {
  MemoryCatalogRepository,
  type MenuItemDTO,
  type RestaurantDTO,
} from "../repositories/catalogRepository";

const REST_ID = "c0000000-0000-4000-8000-000000000001";
const ITEM_ID = "c0000000-0000-4000-8000-000000000101";
const ITEM_ZERO_PRICE = "c0000000-0000-4000-8000-000000000102";
const ITEM_BAD_NON_FINITE = "c0000000-0000-4000-8000-000000000103";
const ITEM_BAD_NEGATIVE = "c0000000-0000-4000-8000-000000000104";
const ITEM_BAD_DUPLICATE = "c0000000-0000-4000-8000-000000000105";
const ITEM_BAD_MALFORMED = "c0000000-0000-4000-8000-000000000106";
const SENDER_ID = "c0000000-0000-4000-8000-000000000201";

const restaurant: RestaurantDTO = {
  id: REST_ID,
  name: "Fixture Kitchen",
  gst_number: null,
  fssai_license: null,
  owner_id: "c0000000-0000-4000-8000-000000000301",
  commission_rate: 0.08,
  is_active: true,
  lat: 19.0,
  lng: 72.8,
  pickup_eta_min: 15,
  rating: null,
  cuisines: [],
  price_for_one: null,
  cover_image: null,
};

function makeItem(id: string, overrides: Partial<MenuItemDTO> = {}): MenuItemDTO {
  return {
    id,
    restaurant_id: REST_ID,
    name: "Loaded Nachos",
    price: 100,
    description: null,
    dietary_tags: { VEG: true },
    customizations: [
      { name: "Extra Cheese", price_delta: 30 },
      { name: "Cheese Burst", price_delta: 0 },
    ],
    image_url: null,
    pos_item_id: null,
    is_available: true,
    spice_level: 2,
    ...overrides,
  };
}

function seedMenu(): MenuItemDTO[] {
  return [
    makeItem(ITEM_ID),
    makeItem(ITEM_ZERO_PRICE, { price: 0, customizations: [] }),
    makeItem(ITEM_BAD_NON_FINITE, {
      customizations: [{ name: "Extra Cheese", price_delta: Number.NaN }],
    }),
    makeItem(ITEM_BAD_NEGATIVE, {
      customizations: [{ name: "Extra Cheese", price_delta: -5 }],
    }),
    makeItem(ITEM_BAD_DUPLICATE, {
      customizations: [
        { name: "Extra Cheese", price_delta: 10 },
        { name: "Extra Cheese", price_delta: 20 },
      ],
    }),
    makeItem(ITEM_BAD_MALFORMED, { customizations: [42] }),
  ];
}

describe("GiftService.create customization pricing (Task 2G)", () => {
  let giftRepo: MemoryGiftRepository;
  let paymentRepo: MemoryPaymentRepository;
  let catalogRepo: MemoryCatalogRepository;
  let service: GiftService;

  beforeEach(() => {
    giftRepo = new MemoryGiftRepository();
    paymentRepo = new MemoryPaymentRepository();
    catalogRepo = new MemoryCatalogRepository([restaurant], seedMenu());
    service = new GiftService(giftRepo, paymentRepo, catalogRepo);
    paymentRepo._reset();
  });

  async function create(
    menuItemId: string,
    customizations: { name: string; price_delta: number }[],
  ) {
    return service.create({
      sender_id: SENDER_ID,
      restaurant_id: REST_ID,
      menu_item_id: menuItemId,
      customizations,
    });
  }

  it("prices from the catalog when the client forges a large negative delta", async () => {
    const gift = await create(ITEM_ID, [{ name: "Extra Cheese", price_delta: -499 }]);
    expect(gift.price_paid).toBe(130);
  });

  it("resolves every forged delta to the catalog price", async () => {
    const low = await create(ITEM_ID, [{ name: "Extra Cheese", price_delta: 1 }]);
    const high = await create(ITEM_ID, [{ name: "Extra Cheese", price_delta: 999999 }]);
    expect(low.price_paid).toBe(130);
    expect(high.price_paid).toBe(130);
  });

  it("persists catalog prices in the item snapshot, not the client deltas", async () => {
    const gift = await create(ITEM_ID, [{ name: "Extra Cheese", price_delta: 999 }]);
    expect(gift.item_snapshot.customizations).toEqual([{ name: "Extra Cheese", price_delta: 30 }]);
  });

  it("rejects a customization the item does not offer", async () => {
    await expect(
      create(ITEM_ID, [{ name: "Truffle Oil", price_delta: 50 }]),
    ).rejects.toMatchObject({ code: "INVALID_CUSTOMIZATION" });
  });

  it("rejects a customization requested twice", async () => {
    await expect(
      create(ITEM_ID, [
        { name: "Extra Cheese", price_delta: 30 },
        { name: "Extra Cheese", price_delta: 30 },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_CUSTOMIZATION" });
  });

  it("fails closed on a non-finite catalog price", async () => {
    await expect(
      create(ITEM_BAD_NON_FINITE, [{ name: "Extra Cheese", price_delta: 1 }]),
    ).rejects.toMatchObject({ code: "INVALID_CATALOG_CUSTOMIZATION" });
  });

  it("fails closed on a negative catalog price", async () => {
    await expect(
      create(ITEM_BAD_NEGATIVE, [{ name: "Extra Cheese", price_delta: 1 }]),
    ).rejects.toMatchObject({ code: "INVALID_CATALOG_CUSTOMIZATION" });
  });

  it("fails closed on a duplicate catalog customization name", async () => {
    await expect(
      create(ITEM_BAD_DUPLICATE, [{ name: "Extra Cheese", price_delta: 1 }]),
    ).rejects.toMatchObject({ code: "INVALID_CATALOG_CUSTOMIZATION" });
  });

  it("fails closed on a malformed catalog customization entry", async () => {
    await expect(
      create(ITEM_BAD_MALFORMED, [{ name: "Extra Cheese", price_delta: 1 }]),
    ).rejects.toMatchObject({ code: "INVALID_CATALOG_CUSTOMIZATION" });
  });

  it("accepts a free (zero-delta) catalog option", async () => {
    const gift = await create(ITEM_ID, [{ name: "Cheese Burst", price_delta: 0 }]);
    expect(gift.price_paid).toBe(100);
    expect(gift.item_snapshot.customizations).toEqual([{ name: "Cheese Burst", price_delta: 0 }]);
  });

  it("keeps the base price when no customizations are requested", async () => {
    const gift = await create(ITEM_ID, []);
    expect(gift.price_paid).toBe(100);
    expect(gift.item_snapshot.customizations).toEqual([]);
  });

  it("guards against a non-positive computed price", async () => {
    await expect(create(ITEM_ZERO_PRICE, [])).rejects.toMatchObject({
      code: "INVALID_PRICE",
    });
  });
});
