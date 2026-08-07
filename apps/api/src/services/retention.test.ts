import { beforeEach, describe, expect, it } from "vitest";
import { sharedLoyaltyRepo, sharedOrderRepo, sharedPromotionRepo } from "../repositories/shared";
import { RetentionService, utcDayKey } from "./retention";
import type { OrderDTO } from "../repositories/orderRepository";

// ============================================
// Retention service (O12 wallet cashback + L02 pickup streak)
// ============================================

const USER_ID = "00000000-0000-4000-8000-0000000000c1";
const REST_ID = "a0000000-0000-4000-8000-000000000001";

async function seedOrder(totalAmount: number): Promise<OrderDTO> {
  const created = await sharedOrderRepo.create({
    user_id: USER_ID,
    restaurant_id: REST_ID,
    items: [],
    breakdown: {
      items: [],
      food_subtotal: totalAmount,
      packaging_fee: 0,
      packaging_fee_per_item: 0,
      gst_food: 0,
      gst_packaging: 0,
      total_amount: totalAmount,
      commission_rate: 0,
      commission_amount: 0,
    },
  });
  return (await sharedOrderRepo.updateStatus(created.id, "PICKED_UP"))!;
}

describe("RetentionService", () => {
  beforeEach(() => {
    sharedOrderRepo._reset();
    sharedLoyaltyRepo._reset();
    sharedPromotionRepo._reset();
  });

  describe("O12 wallet cashback", () => {
    it("credits 1% of the order total (Rs 500 -> Rs 5)", async () => {
      const order = await seedOrder(500);
      const service = new RetentionService(
        sharedLoyaltyRepo,
        sharedOrderRepo,
        sharedPromotionRepo,
      );

      const result = await service.onOrderPickedUp(order.id);
      expect(result).toEqual({ cashback: 5, balance: 5 });

      const wallet = await sharedLoyaltyRepo.getWallet(USER_ID);
      expect(wallet.balance).toBe(5);
      expect(wallet.total_earned).toBe(5);

      const txs = await sharedLoyaltyRepo.getWalletTransactions(USER_ID);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        user_id: USER_ID,
        amount: 5,
        reason: "pickup_cashback",
        balance_after: 5,
      });
    });

    it("accumulates across orders and keeps the ledger", async () => {
      const a = await seedOrder(250);
      const b = await seedOrder(250);
      const service = new RetentionService(
        sharedLoyaltyRepo,
        sharedOrderRepo,
        sharedPromotionRepo,
      );

      await service.onOrderPickedUp(a.id);
      await service.onOrderPickedUp(b.id);

      const wallet = await sharedLoyaltyRepo.getWallet(USER_ID);
      expect(wallet.balance).toBe(5);
      expect((await sharedLoyaltyRepo.getWalletTransactions(USER_ID))).toHaveLength(2);
    });

    it("is a no-op for unknown orders", async () => {
      const service = new RetentionService(
        sharedLoyaltyRepo,
        sharedOrderRepo,
        sharedPromotionRepo,
      );
      expect(await service.onOrderPickedUp("missing-order")).toBeNull();
    });
  });

  describe("L02 pickup streak", () => {
    it("mints a 10% coupon + badge on the 7th consecutive day", async () => {
      // Seed 6 consecutive real prior days directly on the repo, then let
      // the service (real clock) record today as the 7th consecutive day.
      const base = new Date();
      const dayKey = (daysAgo: number) =>
        new Date(base.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
      for (let i = 6; i >= 1; i -= 1) {
        await sharedLoyaltyRepo.recordPickup(USER_ID, dayKey(i));
      }
      expect((await sharedLoyaltyRepo.getStreak(USER_ID)).current_streak).toBe(6);

      const order = await seedOrder(100);
      const service = new RetentionService(
        sharedLoyaltyRepo,
        sharedOrderRepo,
        sharedPromotionRepo,
      );
      const result = await service.onOrderPickedUpStreak(order.id);

      expect(result.badge_unlocked).toBe(true);
      expect(result.streak).toBe(7);
      expect(result.coupon_code).toBe("SNKZ-STREAK-7");

      const streak = await sharedLoyaltyRepo.getStreak(USER_ID);
      expect(streak.current_streak).toBe(7);
      expect(streak.best_streak).toBe(7);

      const promos = await sharedPromotionRepo.listActive();
      expect(promos.some((p) => p.value === 10 && p.discount_type === "PERCENTAGE")).toBe(true);
    });

    it("is idempotent within the same day", async () => {
      const fixedNow = () => new Date("2026-02-01T12:00:00Z");
      const order = await seedOrder(100);

      const service = new RetentionService(
        sharedLoyaltyRepo,
        sharedOrderRepo,
        sharedPromotionRepo,
        fixedNow,
      );
      await service.onOrderPickedUpStreak(order.id);
      const result = await service.onOrderPickedUpStreak(order.id);

      expect(result.advanced).toBe(false);
      expect(result.streak).toBe(1);
    });

    it("resets after a gap of more than one day", async () => {
      const orderA = await seedOrder(100);
      const service = new RetentionService(
        sharedLoyaltyRepo,
        sharedOrderRepo,
        sharedPromotionRepo,
        () => new Date("2026-02-01T12:00:00Z"),
      );
      await service.onOrderPickedUpStreak(orderA.id);

      const orderB = await seedOrder(100);
      const serviceB = new RetentionService(
        sharedLoyaltyRepo,
        sharedOrderRepo,
        sharedPromotionRepo,
        () => new Date("2026-02-04T12:00:00Z"),
      );
      const result = await serviceB.onOrderPickedUpStreak(orderB.id);

      expect(result.streak).toBe(1);
      expect(result.advanced).toBe(true);
      const streak = await sharedLoyaltyRepo.getStreak(USER_ID);
      expect(streak.current_streak).toBe(1);
      expect(streak.last_pickup_day).toBe("2026-02-04");
    });
  });

  it("utcDayKey returns the UTC YYYY-MM-DD slice", () => {
    expect(utcDayKey(new Date("2026-02-07T18:30:00Z"))).toBe("2026-02-07");
  });
});
