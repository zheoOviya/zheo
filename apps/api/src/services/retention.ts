import { createEventEnvelope, emit, onEvent } from "../lib/eventBus";
import { sharedLoyaltyRepo, sharedOrderRepo, sharedPromotionRepo } from "../repositories/shared";
import type { LoyaltyRepository } from "../repositories/loyaltyRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import type { PromotionRepository } from "../repositories/promotionRepository";
import { logger } from "../lib/logger";

// ============================================
// Retention context service (loyalty bounded context)
// O12 SnakZap Wallet & Cashback + L02 Pickup Streak Badges.
// Reacts to OrderPickedUp:
//   - credits 1% of the order total to the consumer wallet
//   - advances the consecutive-pickup-day streak; every 7th day mints a
//     10%-off coupon and emits StreakBadgeUnlocked
// ============================================

export const CASHBACK_RATE = 0.01;
export const STREAK_BADGE_DAYS = 7;
export const STREAK_COUPON_DISCOUNT = 0.1;
export const STREAK_COUPON_VALID_DAYS = 30;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** UTC day key (YYYY-MM-DD) for a Date. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class RetentionService {
  constructor(
    private readonly loyaltyRepo: LoyaltyRepository,
    private readonly orderRepo: OrderRepository,
    private readonly promotionRepo: PromotionRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** O12: wallet cashback on pickup. Returns null when the order is unknown. */
  async onOrderPickedUp(orderId: string): Promise<{ cashback: number; balance: number } | null> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) return null;

    const cashback = round2(order.total_amount * CASHBACK_RATE);
    const wallet = await this.loyaltyRepo.creditWallet(
      order.user_id,
      cashback,
      "pickup_cashback",
    );

    logger.info({
      message: "wallet_cashback_credited",
      user_id: order.user_id,
      order_id: order.id,
      cashback,
      balance: wallet.balance,
    });

    await emit(
      createEventEnvelope("WalletCashbackCredited", order.user_id, {
        user_id: order.user_id,
        order_id: order.id,
        amount: cashback,
        balance_after: wallet.balance,
      }),
    );
    return { cashback, balance: wallet.balance };
  }

  /**
   * L02: advances the pickup streak for the current day. When the streak
   * hits a multiple of 7 it mints a 10%-off coupon (30-day validity) and
   * emits StreakBadgeUnlocked.
   */
  async onOrderPickedUpStreak(
    orderId: string,
  ): Promise<{
    advanced: boolean;
    badge_unlocked: boolean;
    streak: number;
    coupon_code: string | null;
    discount_rate: number;
  }> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) {
      return {
        advanced: false,
        badge_unlocked: false,
        streak: 0,
        coupon_code: null,
        discount_rate: STREAK_COUPON_DISCOUNT,
      };
    }

    const day = utcDayKey(this.now());
    const result = await this.loyaltyRepo.recordPickup(order.user_id, day);

    let couponCode: string | null = null;
    if (result.badge_unlocked) {
      couponCode = `SNKZ-STREAK-${result.streak.current_streak}`;
      const validUntil = new Date(
        this.now().getTime() + STREAK_COUPON_VALID_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      await this.promotionRepo.create({
        title: `${result.streak.current_streak}-day pickup streak`,
        discount_type: "PERCENTAGE",
        value: STREAK_COUPON_DISCOUNT * 100,
        valid_until: validUntil,
      });
      await emit(
        createEventEnvelope("StreakBadgeUnlocked", order.user_id, {
          user_id: order.user_id,
          streak: result.streak.current_streak,
          coupon_code: couponCode,
          discount_rate: STREAK_COUPON_DISCOUNT,
        }),
      );
    }

    logger.info({
      message: "pickup_streak_updated",
      user_id: order.user_id,
      order_id: order.id,
      current_streak: result.streak.current_streak,
      advanced: result.advanced,
      badge_unlocked: result.badge_unlocked,
    });

    return {
      advanced: result.advanced,
      badge_unlocked: result.badge_unlocked,
      streak: result.streak.current_streak,
      coupon_code: couponCode,
      discount_rate: STREAK_COUPON_DISCOUNT,
    };
  }

  async getWallet(userId: string) {
    const wallet = await this.loyaltyRepo.getWallet(userId);
    const transactions = await this.loyaltyRepo.getWalletTransactions(userId);
    return { ...wallet, transactions };
  }

  async getStreak(userId: string) {
    const streak = await this.loyaltyRepo.getStreak(userId);
    const nextBadgeAt =
      streak.current_streak >= STREAK_BADGE_DAYS
        ? (Math.floor(streak.current_streak / STREAK_BADGE_DAYS) + 1) *
          STREAK_BADGE_DAYS
        : STREAK_BADGE_DAYS;
    return {
      current_streak: streak.current_streak,
      best_streak: streak.best_streak,
      last_pickup_day: streak.last_pickup_day,
      days_to_next_badge: Math.max(0, nextBadgeAt - streak.current_streak),
    };
  }
}

// ============================================
// EOS Layer 1 wiring
// ============================================

const retentionService = new RetentionService(
  sharedLoyaltyRepo,
  sharedOrderRepo,
  sharedPromotionRepo,
);

export function getRetentionService(): RetentionService {
  return retentionService;
}

let registered = false;

export function registerRetentionEventHandlers(): void {
  if (registered) return;
  registered = true;
  onEvent("OrderPickedUp", async (event) => {
    const payload = event.payload as { order_id: string };
    await retentionService.onOrderPickedUp(payload.order_id);
    await retentionService.onOrderPickedUpStreak(payload.order_id);
  });
}
