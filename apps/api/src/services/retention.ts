import { createEventEnvelope, emit, onEvent } from "../lib/eventBus";
import { sharedLoyaltyRepo, sharedOrderRepo, sharedPromotionRepo } from "../repositories/shared";
import type { LoyaltyRepository } from "../repositories/loyaltyRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import type { PromotionRepository } from "../repositories/promotionRepository";
import { getConsumerTransactionPort } from "../repositories/drizzle/consumerTransactionPort";
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

/** EVT-C2 durable consumer names. Distinct per effect so each can be redelivered
 *  and retried independently without cross-suppressing the other. */
export const CONSUMER_CASHBACK = "retention.cashback";
export const CONSUMER_STREAK = "retention.streak";

/** Repositories a retention effect writes through (transaction-scoped for the
 *  durable consumer path; the service's own repos for direct/legacy calls). */
export interface RetentionEffectDeps {
  loyalty: LoyaltyRepository;
  orders: OrderRepository;
  promotions: PromotionRepository;
}

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

  private effectDeps(): RetentionEffectDeps {
    return {
      loyalty: this.loyaltyRepo,
      orders: this.orderRepo,
      promotions: this.promotionRepo,
    };
  }

  /**
   * Cashback effect only (no event emit). Used by both the legacy public method
   * and the atomic EVT-C2 consumer, which supplies a transaction-scoped deps so
   * the wallet credit/ledger append shares the marker's transaction.
   */
  async applyCashback(
    orderId: string,
    deps: RetentionEffectDeps = this.effectDeps(),
  ): Promise<{
    user_id: string;
    order_id: string;
    cashback: number;
    balance: number;
  } | null> {
    const order = await deps.orders.getById(orderId);
    if (!order) return null;

    const cashback = round2(order.total_amount * CASHBACK_RATE);
    const wallet = await deps.loyalty.creditWallet(
      order.user_id,
      cashback,
      "pickup_cashback",
    );

    return {
      user_id: order.user_id,
      order_id: order.id,
      cashback,
      balance: wallet.balance,
    };
  }

  /** O12: wallet cashback on pickup. Returns null when the order is unknown. */
  async onOrderPickedUp(orderId: string): Promise<{ cashback: number; balance: number } | null> {
    const result = await this.applyCashback(orderId);
    if (!result) return null;

    logger.info({
      message: "wallet_cashback_credited",
      user_id: result.user_id,
      order_id: result.order_id,
      cashback: result.cashback,
      balance: result.balance,
    });

    await emit(
      createEventEnvelope("WalletCashbackCredited", result.user_id, {
        user_id: result.user_id,
        order_id: result.order_id,
        amount: result.cashback,
        balance_after: result.balance,
      }),
    );
    return { cashback: result.cashback, balance: result.balance };
  }

  /**
   * Streak effect only (no event emit). Advances the streak and, when a badge
   * unlocks, persists the 10%-off promotion through the SAME deps (transaction
   * for the durable consumer path).
   */
  async applyStreak(
    orderId: string,
    deps: RetentionEffectDeps = this.effectDeps(),
    now: () => Date = this.now,
  ): Promise<{
    order_found: boolean;
    user_id: string | null;
    advanced: boolean;
    badge_unlocked: boolean;
    streak: number;
    coupon_code: string | null;
    discount_rate: number;
  }> {
    const order = await deps.orders.getById(orderId);
    if (!order) {
      return {
        order_found: false,
        user_id: null,
        advanced: false,
        badge_unlocked: false,
        streak: 0,
        coupon_code: null,
        discount_rate: STREAK_COUPON_DISCOUNT,
      };
    }

    const day = utcDayKey(now());
    const result = await deps.loyalty.recordPickup(order.user_id, day);

    let couponCode: string | null = null;
    if (result.badge_unlocked) {
      couponCode = `SNKZ-STREAK-${result.streak.current_streak}`;
      const validUntil = new Date(
        now().getTime() + STREAK_COUPON_VALID_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      await deps.promotions.create({
        title: `${result.streak.current_streak}-day pickup streak`,
        discount_type: "PERCENTAGE",
        value: STREAK_COUPON_DISCOUNT * 100,
        valid_until: validUntil,
      });
    }

    return {
      order_found: true,
      user_id: order.user_id,
      advanced: result.advanced,
      badge_unlocked: result.badge_unlocked,
      streak: result.streak.current_streak,
      coupon_code: couponCode,
      discount_rate: STREAK_COUPON_DISCOUNT,
    };
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
    const result = await this.applyStreak(orderId);

    if (result.order_found) {
      logger.info({
        message: "pickup_streak_updated",
        user_id: result.user_id,
        order_id: orderId,
        current_streak: result.streak,
        advanced: result.advanced,
        badge_unlocked: result.badge_unlocked,
      });

      if (result.badge_unlocked) {
        await emit(
          createEventEnvelope("StreakBadgeUnlocked", result.user_id as string, {
            user_id: result.user_id,
            streak: result.streak,
            coupon_code: result.coupon_code,
            discount_rate: STREAK_COUPON_DISCOUNT,
          }),
        );
      }
    }

    return {
      advanced: result.advanced,
      badge_unlocked: result.badge_unlocked,
      streak: result.streak,
      coupon_code: result.coupon_code,
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

  // Atomic, idempotent cashback consumer (EVT-C2): the marker claim and the
  // wallet credit + ledger append share one transaction. A duplicate delivery
  // loses the claim and performs zero business mutation; an effect failure
  // rolls the marker back and rejects so the durable publisher retries.
  onEvent("OrderPickedUp", async (event) => {
    const payload = event.payload as { order_id: string };
    const result = await getConsumerTransactionPort().runInTransaction(
      async (scope) => {
        const won = await scope.claim(CONSUMER_CASHBACK, event.event_id);
        if (!won) return null;
        return retentionService.applyCashback(payload.order_id, {
          loyalty: scope.loyalty,
          orders: scope.orders,
          promotions: scope.promotions,
        });
      },
    );
    if (!result) return;

    logger.info({
      message: "wallet_cashback_credited",
      user_id: result.user_id,
      order_id: result.order_id,
      cashback: result.cashback,
      balance: result.balance,
    });
    await emit(
      createEventEnvelope("WalletCashbackCredited", result.user_id, {
        user_id: result.user_id,
        order_id: result.order_id,
        amount: result.cashback,
        balance_after: result.balance,
      }),
    );
  });

  // Atomic, idempotent streak consumer (EVT-C2): marker claim + recordPickup +
  // any badge promotion share one transaction, so a redelivery across days
  // cannot advance the streak twice and a duplicate cannot mint a second badge.
  onEvent("OrderPickedUp", async (event) => {
    const payload = event.payload as { order_id: string };
    const result = await getConsumerTransactionPort().runInTransaction(
      async (scope) => {
        const won = await scope.claim(CONSUMER_STREAK, event.event_id);
        if (!won) return null;
        return retentionService.applyStreak(payload.order_id, {
          loyalty: scope.loyalty,
          orders: scope.orders,
          promotions: scope.promotions,
        });
      },
    );
    if (!result || !result.order_found) return;

    logger.info({
      message: "pickup_streak_updated",
      user_id: result.user_id,
      order_id: payload.order_id,
      current_streak: result.streak,
      advanced: result.advanced,
      badge_unlocked: result.badge_unlocked,
    });

    if (result.badge_unlocked) {
      await emit(
        createEventEnvelope("StreakBadgeUnlocked", result.user_id as string, {
          user_id: result.user_id,
          streak: result.streak,
          coupon_code: result.coupon_code,
          discount_rate: STREAK_COUPON_DISCOUNT,
        }),
      );
    }
  });
}
