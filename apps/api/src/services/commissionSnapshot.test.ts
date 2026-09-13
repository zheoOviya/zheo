import { beforeEach, describe, expect, it } from "vitest";
import type { CatalogRepository } from "../repositories/catalogRepository";
import {
  MemoryOrderRepository,
  type CreateOrderInput,
  type OrderDTO,
  type OrderItemDTO,
} from "../repositories/orderRepository";
import { resolveCommission } from "../repositories/drizzle/drizzleOrderRepository";
import { resetRedisForTests } from "../lib/redis";
import { OrderingService } from "./ordering";
import { calculatePriceBreakdown, computeCommission } from "./pricing";
import { computeSettlementLine } from "./settlement";

// ============================================
// COMMISSION-SNAPSHOT-MIGRATION-A3 unit coverage (U1-U6, U8 + regression).
//
// Policy is FROZEN FLAT_THRESHOLD (0% at/below 200, 8% above). New orders
// snapshot commission_rate + commission_amount; legacy NULL snapshot rows
// recompute canonically on read and are never mutated (DB-null proof is the
// real-PG harness P3). restaurants.commission_rate is never a money input.
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM = "b0000000-0000-4000-8000-000000000001";
const USER_ID = "u00000000-0000-4000-8000-000000000001";

function buildInput(basePrice: number, quantity = 1): CreateOrderInput {
  const lines = [
    {
      menu_item_id: MENU_ITEM,
      name: "Biryani",
      base_price: basePrice,
      quantity,
      customizations: [],
    },
  ];
  const breakdown = calculatePriceBreakdown(lines);
  return {
    user_id: USER_ID,
    restaurant_id: REST_ID,
    items: lines.map((line) => ({
      ...line,
      gift_id: null,
      customization_total:
        breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)
          ?.customization_total ?? 0,
      item_subtotal:
        breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)
          ?.item_subtotal ?? 0,
    })),
    breakdown,
  };
}

function orderWithSnapshot(
  totalAmount: number,
  rate: number,
  amount: number,
): OrderDTO {
  const created = new Date().toISOString();
  const item: OrderItemDTO = {
    id: "itm-1",
    menu_item_id: MENU_ITEM,
    name: "Biryani",
    base_price: totalAmount,
    quantity: 1,
    customizations: [],
    customization_total: 0,
    item_subtotal: totalAmount,
    gift_id: null,
  };
  return {
    id: "o-commission-1",
    user_id: USER_ID,
    restaurant_id: REST_ID,
    items: [item],
    total_amount: totalAmount,
    status: "PICKED_UP",
    commission_rate: rate,
    commission_amount: amount,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: created,
    updated_at: created,
  };
}

/** Minimal catalog stub: only the two reads OrderingService performs. */
class FakeCatalog {
  constructor(public rate: number) {}
  async getRestaurantById(id: string) {
    return { id, name: "Vendor", is_active: true, commission_rate: this.rate };
  }
  async getMenuItemById(id: string) {
    return { id, restaurant_id: REST_ID, name: "Biryani", price: 220, is_available: true };
  }
}

describe("COMMISSION-SNAPSHOT-MIGRATION-A3", () => {
  describe("U1/U2 canonical flat-threshold formula and boundary", () => {
    it("U1: <=200 is 0%, >200 is 8%", () => {
      expect(computeCommission(100)).toEqual({ rate: 0, amount: 0 });
      expect(computeCommission(500)).toEqual({ rate: 0.08, amount: 40 });
    });

    it("U2: exactly 200 is 0%; 201 is 8%/16.08", () => {
      expect(computeCommission(200)).toEqual({ rate: 0, amount: 0 });
      expect(computeCommission(201)).toEqual({ rate: 0.08, amount: 16.08 });
    });
  });

  describe("U3/U5 snapshot creation + Memory parity", () => {
    let repo: MemoryOrderRepository;

    beforeEach(() => {
      repo = new MemoryOrderRepository();
    });

    it("U3: a new order snapshots the exact canonical rate+amount", async () => {
      const input = buildInput(220);
      const created = await repo.create(input);
      expect(created.total_amount).toBe(242.8);
      expect(created.commission_rate).toBe(0.08);
      expect(created.commission_amount).toBe(19.42);

      const reread = await repo.getById(created.id);
      expect(reread?.commission_rate).toBe(0.08);
      expect(reread?.commission_amount).toBe(19.42);
    });

    it("U5: snapshot equals calculatePriceBreakdown output (no divergence)", async () => {
      const input = buildInput(450);
      const created = await repo.create(input);
      const canonical = computeCommission(input.breakdown.total_amount);
      expect(created.commission_rate).toBe(input.breakdown.commission_rate);
      expect(created.commission_amount).toBe(input.breakdown.commission_amount);
      expect(created.commission_rate).toBe(canonical.rate);
      expect(created.commission_amount).toBe(canonical.amount);
    });

    it("regression: low-value persisted 0.00 rate survives reread", async () => {
      const created = await repo.create(buildInput(50));
      const reread = await repo.getById(created.id);
      expect(reread?.total_amount).toBeLessThanOrEqual(200);
      expect(reread?.commission_rate).toBe(0);
      expect(reread?.commission_amount).toBe(0);
    });
  });

  describe("U4 restaurant rate is not a money input", () => {
    beforeEach(() => {
      resetRedisForTests();
    });

    it("U4: changing the restaurant rate after creation does not alter the snapshot", async () => {
      const orderRepo = new MemoryOrderRepository();
      const catalog = new FakeCatalog(0.05);
      const service = new OrderingService(
        orderRepo,
        catalog as unknown as CatalogRepository,
      );

      const placed = await service.placeOrder({
        user_id: USER_ID,
        restaurant_id: REST_ID,
        items: [{ menu_item_id: MENU_ITEM, quantity: 1, customizations: [] }],
      });
      expect(placed.commission_rate).toBe(0.08);
      expect(placed.commission_amount).toBe(19.42);

      catalog.rate = 0.09;
      const reread = await orderRepo.getById(placed.id);
      expect(reread?.commission_rate).toBe(0.08);
      expect(reread?.commission_amount).toBe(19.42);
    });
  });

  describe("U6 settlement uses the persisted snapshot", () => {
    it("U6: a persisted non-canonical amount is honored, not recomputed", () => {
      const line = computeSettlementLine(orderWithSnapshot(500, 0.05, 12.34));
      expect(line.commission_rate).toBe(0.05);
      expect(line.commission_amount).toBe(12.34);
      expect(line.commission_amount).not.toBe(40);
    });
  });

  describe("U8 / PG fallback: legacy NULL canonical recompute", () => {
    it("U8a: legacy NULL recomputes canonically and never fabricates 0.08/0", () => {
      expect(resolveCommission(null, null, 250)).toEqual({ rate: 0.08, amount: 20 });
      expect(resolveCommission(undefined, undefined, 100)).toEqual({ rate: 0, amount: 0 });
    });

    it("U8b: a present snapshot is returned verbatim (never recomputed)", () => {
      expect(resolveCommission("0.05", "12.34", 500)).toEqual({ rate: 0.05, amount: 12.34 });
    });
  });
});
