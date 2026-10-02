import { createEventEnvelope, emit, onEvent } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import {
  sharedAuditRepo,
  sharedLoyaltyRepo,
  sharedOrderRepo,
} from "../repositories/shared";
import type {
  LoyaltyRepository,
  StampCard,
} from "../repositories/loyaltyRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import type { ReferralTransactionPort } from "../repositories/producerRemainingAtomicityContracts";
import { getConsumerTransactionPort } from "../repositories/drizzle/consumerTransactionPort";
import { getReferralTransactionPort } from "../repositories/drizzle/producerRemainingTransactionPort";
import { logger } from "../lib/logger";

// ============================================
// Loyalty context service (loyalty bounded context)
// L05 Refer & Earn with IP + device-fingerprint fraud
// prevention, and L01 per-restaurant Stamp Cards driven
// by the OrderPickedUp event.
// ============================================

export const REFERRAL_BONUS = 50;
export const STAMP_CARD_SIZE = 10;

/** EVT-C2 durable consumer names. */
export const CONSUMER_ORDER_STAMP = "loyalty.order_stamp";
export const CONSUMER_GIFT_STAMP = "loyalty.gift_stamp";

/** Repositories a stamp effect writes through (transaction-scoped for the
 *  durable consumer path; the service's own repos for direct/legacy calls). */
export interface LoyaltyStampEffectDeps {
  loyalty: LoyaltyRepository;
  orders: OrderRepository;
}

export interface ApplyReferralInput {
  claimantUserId: string;
  referralCode: string;
  ipAddress?: string;
  deviceFingerprint?: string;
}

export interface ApplyReferralResult {
  referral_code: string;
  referrer_user_id: string;
  bonus_amount: number;
  balance: number;
  total_earned: number;
  claimed: true;
}

export class LoyaltyService {
  constructor(
    private readonly repo: LoyaltyRepository,
    private readonly orderRepo: OrderRepository,
    private readonly referralPort?: ReferralTransactionPort,
  ) {}

  /**
   * Transaction port for the referral claim. Injected port is preferred (tests);
   * otherwise the storage-mode-aware selector binds the service's own loyalty
   * repo so memory/test passthrough observes the same store.
   */
  private getReferralPort(): ReferralTransactionPort {
    return this.referralPort ?? getReferralTransactionPort(this.repo);
  }

  async getReferralProfile(userId: string) {
    const referral_code = await this.repo.getReferralCode(userId);
    const wallet = await this.repo.getWallet(userId);
    return {
      referral_code,
      bonus_amount: REFERRAL_BONUS,
      balance: wallet.balance,
      total_earned: wallet.total_earned,
    };
  }

  /**
   * L05 apply-referral. Five gates run BEFORE any money moves:
   * valid code -> not self-referral -> not already used -> IP clean
   * -> device clean. The IP/device gates answer "has this IP / this
   * browser fingerprint already claimed a referral?" and, if so, the
   * request is rejected 403 FRAUD_DETECTED (bonus never credited).
   */
  async applyReferral(input: ApplyReferralInput): Promise<ApplyReferralResult> {
    const { claimantUserId, referralCode } = input;
    const ipAddress = input.ipAddress ?? null;
    const deviceFingerprint = input.deviceFingerprint ?? null;

    const referrerUserId = await this.repo.getReferrerByCode(referralCode);
    if (!referrerUserId) {
      throw new AppError("INVALID_REFERRAL_CODE", "Unknown referral code", 400);
    }

    if (referrerUserId === claimantUserId) {
      throw new AppError(
        "SELF_REFERRAL",
        "You cannot use your own referral code",
        400,
      );
    }

    if (await this.repo.hasUserClaimed(claimantUserId)) {
      throw new AppError(
        "REFERRAL_ALREADY_USED",
        "This account has already used a referral code",
        400,
      );
    }

    // Fraud Prevention (EOS Layer 2) - same network or same device cannot
    // farm the bonus, regardless of the account used.
    if (ipAddress && (await this.repo.hasClaimedByIp(ipAddress))) {
      await sharedAuditRepo.log(claimantUserId, "referral_fraud_blocked", {
        referral_code: referralCode.trim().toUpperCase(),
        referrer_user_id: referrerUserId,
        dimension: "ip",
        ip_address: ipAddress,
      });
      throw new AppError(
        "FRAUD_DETECTED",
        "This network has already claimed a referral",
        403,
      );
    }

    if (
      deviceFingerprint &&
      (await this.repo.hasClaimedByDevice(deviceFingerprint))
    ) {
      await sharedAuditRepo.log(claimantUserId, "referral_fraud_blocked", {
        referral_code: referralCode.trim().toUpperCase(),
        referrer_user_id: referrerUserId,
        dimension: "device",
      });
      throw new AppError(
        "FRAUD_DETECTED",
        "This device has already claimed a referral",
        403,
      );
    }

    // Claim record, referrer credit, claimant credit, the durable
    // `referral_applied` audit row and the ReferralClaimed event row all share
    // ONE transaction (EVT-B2B-NP2), so a failure can never leave a partial
    // credit or a credited-but-unrecorded claim. The old post-commit emit is
    // gone.
    const claimantWallet = await this.getReferralPort().runInTransaction(
      async ({ loyalty, audit, outbox }) => {
        await loyalty.recordClaim({
          claimant_user_id: claimantUserId,
          referrer_user_id: referrerUserId,
          referral_code: referralCode.trim().toUpperCase(),
          bonus_amount: REFERRAL_BONUS,
          ip_address: ipAddress,
          device_fingerprint: deviceFingerprint,
        });

        // Rs 50 for the referrer AND Rs 50 for the claimant.
        await loyalty.creditWallet(referrerUserId, REFERRAL_BONUS, "referral_bonus");
        const wallet = await loyalty.creditWallet(
          claimantUserId,
          REFERRAL_BONUS,
          "referral_bonus",
        );

        await audit.log(claimantUserId, "referral_applied", {
          referral_code: referralCode.trim().toUpperCase(),
          referrer_user_id: referrerUserId,
          bonus_amount: REFERRAL_BONUS,
          ip_address: ipAddress,
        });

        await outbox.enqueue(
          createEventEnvelope("ReferralClaimed", claimantUserId, {
            referrer_user_id: referrerUserId,
            claimant_user_id: claimantUserId,
            referral_code: referralCode.trim().toUpperCase(),
            bonus_amount: REFERRAL_BONUS,
            ip_address: ipAddress ?? undefined,
            device_fingerprint: deviceFingerprint ?? undefined,
          }),
        );

        return wallet;
      },
    );

    logger.info({
      message: "referral_applied",
      claimant_user_id: claimantUserId,
      referrer_user_id: referrerUserId,
      correlation_id: undefined,
    });

    return {
      referral_code: referralCode.trim().toUpperCase(),
      referrer_user_id: referrerUserId,
      bonus_amount: REFERRAL_BONUS,
      balance: claimantWallet.balance,
      total_earned: claimantWallet.total_earned,
      claimed: true,
    };
  }

  // ---- L01 Stamp Card -------------------------------------------------------

  async getStampCard(userId: string, restaurantId: string): Promise<StampCard | null> {
    return this.repo.getStampCard(userId, restaurantId);
  }

  async getStampCards(userId: string): Promise<StampCard[]> {
    return this.repo.getStampCards(userId);
  }

  private stampDeps(): LoyaltyStampEffectDeps {
    return { loyalty: this.repo, orders: this.orderRepo };
  }

  /**
   * Stamp effect only for a paid pickup (no audit/emit side effects). Used by
   * the atomic EVT-C2 consumer, which supplies transaction-scoped deps so the
   * card increment shares the marker's transaction.
   */
  async applyOrderStamp(
    orderId: string,
    deps: LoyaltyStampEffectDeps = this.stampDeps(),
  ): Promise<{
    user_id: string;
    restaurant_id: string;
    before: StampCard | null;
    card: StampCard;
    reward_unlocked: boolean;
  } | null> {
    const order = await deps.orders.getById(orderId);
    if (!order) return null;

    const before = await deps.loyalty.getStampCard(order.user_id, order.restaurant_id);
    const { card, reward_unlocked } = await deps.loyalty.incrementStamp(
      order.user_id,
      order.restaurant_id,
    );

    return {
      user_id: order.user_id,
      restaurant_id: order.restaurant_id,
      before,
      card,
      reward_unlocked,
    };
  }

  /** OrderPickedUp stamp effect, followed by audit log + reward event. */
  async onOrderPickedUp(orderId: string): Promise<StampCard | null> {
    const result = await this.applyOrderStamp(orderId);
    if (!result) return null;
    const { user_id, restaurant_id, before, card, reward_unlocked } = result;

    await sharedAuditRepo.log(user_id, "stamp_incremented", {
      order_id: orderId,
      restaurant_id,
      stamp_count: card.stamp_count,
      total_orders: card.total_orders,
      reward_unlocked,
    });

    if (reward_unlocked) {
      await sharedAuditRepo.log(user_id, "stamp_card_reward_unlocked", {
        order_id: orderId,
        restaurant_id,
        reward_type: "FREE_ITEM",
        stamp_count_before: before?.stamp_count ?? STAMP_CARD_SIZE,
        rewards_earned: card.rewards_earned,
      });
      await emit(
        createEventEnvelope("StampCardRewardUnlocked", user_id, {
          user_id,
          restaurant_id,
          reward_type: "FREE_ITEM",
          stamp_count_before: before?.stamp_count ?? STAMP_CARD_SIZE,
          rewards_earned: card.rewards_earned,
        }),
      );
    }

    return card;
  }

  /**
   * Gift stamp effect only (no audit/emit). The SENDER earns the stamp for a
   * gifted pickup; transaction-scoped deps are supplied by the durable consumer.
   */
  async applyGiftStamp(
    event: { gift_id: string; sender_id: string; restaurant_id: string },
    loyalty: LoyaltyRepository = this.repo,
  ): Promise<{
    before: StampCard | null;
    card: StampCard;
    reward_unlocked: boolean;
  }> {
    const before = await loyalty.getStampCard(event.sender_id, event.restaurant_id);
    const { card, reward_unlocked } = await loyalty.incrementStamp(
      event.sender_id,
      event.restaurant_id,
    );
    return { before, card, reward_unlocked };
  }

  /**
   * GiftFulfilled hook. The SENDER earns the stamp for a gifted pickup
   * (recipient does not double-dip with their own paid items).
   */
  async onGiftFulfilled(event: {
    gift_id: string;
    sender_id: string;
    restaurant_id: string;
  }): Promise<StampCard | null> {
    const { before, card, reward_unlocked } = await this.applyGiftStamp(event);

    await sharedAuditRepo.log(event.sender_id, "gift_stamp_incremented", {
      gift_id: event.gift_id,
      restaurant_id: event.restaurant_id,
      stamp_count: card.stamp_count,
      total_orders: card.total_orders,
      reward_unlocked,
    });

    if (reward_unlocked) {
      await emit(
        createEventEnvelope("StampCardRewardUnlocked", event.sender_id, {
          user_id: event.sender_id,
          restaurant_id: event.restaurant_id,
          reward_type: "FREE_ITEM",
          stamp_count_before: before?.stamp_count ?? STAMP_CARD_SIZE,
          rewards_earned: card.rewards_earned,
        }),
      );
    }

    return card;
  }
}

// ============================================
// EOS Layer 1 wiring - hook the loyalty context
// onto OrderPickedUp so stamp cards fill themselves.
// ============================================

const loyaltyService = new LoyaltyService(
  sharedLoyaltyRepo,
  sharedOrderRepo,
);

export function getLoyaltyService(): LoyaltyService {
  return loyaltyService;
}

let registered = false;

export function registerLoyaltyEventHandlers(): void {
  if (registered) return;
  registered = true;

  // Atomic, idempotent paid-pickup stamp consumer (EVT-C2): marker + card
  // increment share one transaction. Duplicate delivery loses the claim and
  // mutates nothing; a failing effect rolls the marker back and rejects.
  onEvent("OrderPickedUp", async (event) => {
    const payload = event.payload as { order_id: string };
    const result = await getConsumerTransactionPort().runInTransaction(
      async (scope) => {
        const won = await scope.claim(CONSUMER_ORDER_STAMP, event.event_id);
        if (!won) return null;
        const applied = await loyaltyService.applyOrderStamp(payload.order_id, {
          loyalty: scope.loyalty,
          orders: scope.orders,
        });
        if (!applied) return null;
        // EVT-B2B-NP3-A: the nested StampCardRewardUnlocked row is enqueued on
        // the SAME transaction as the dedup marker and the stamp increment, so
        // a rollback drops it and a duplicate delivery enqueues nothing.
        if (applied.reward_unlocked) {
          await scope.outbox.enqueue(
            createEventEnvelope("StampCardRewardUnlocked", applied.user_id, {
              user_id: applied.user_id,
              restaurant_id: applied.restaurant_id,
              reward_type: "FREE_ITEM",
              stamp_count_before:
                applied.before?.stamp_count ?? STAMP_CARD_SIZE,
              rewards_earned: applied.card.rewards_earned,
            }),
          );
        }
        return applied;
      },
    );
    if (!result) return;

    await sharedAuditRepo.log(result.user_id, "stamp_incremented", {
      order_id: payload.order_id,
      restaurant_id: result.restaurant_id,
      stamp_count: result.card.stamp_count,
      total_orders: result.card.total_orders,
      reward_unlocked: result.reward_unlocked,
    });

    if (result.reward_unlocked) {
      await sharedAuditRepo.log(result.user_id, "stamp_card_reward_unlocked", {
        order_id: payload.order_id,
        restaurant_id: result.restaurant_id,
        reward_type: "FREE_ITEM",
        stamp_count_before: result.before?.stamp_count ?? STAMP_CARD_SIZE,
        rewards_earned: result.card.rewards_earned,
      });
    }
  });

  // Atomic, idempotent gift stamp consumer (EVT-C2), distinct consumer name.
  onEvent("GiftFulfilled", async (event) => {
    const payload = event.payload as {
      gift_id: string;
      sender_id: string;
      restaurant_id: string;
    };
    const result = await getConsumerTransactionPort().runInTransaction(
      async (scope) => {
        const won = await scope.claim(CONSUMER_GIFT_STAMP, event.event_id);
        if (!won) return null;
        const applied = await loyaltyService.applyGiftStamp(
          payload,
          scope.loyalty,
        );
        // EVT-B2B-NP3-A: nested StampCardRewardUnlocked enqueued on the SAME
        // transaction as the dedup marker and the gift-stamp increment.
        if (applied.reward_unlocked) {
          await scope.outbox.enqueue(
            createEventEnvelope("StampCardRewardUnlocked", payload.sender_id, {
              user_id: payload.sender_id,
              restaurant_id: payload.restaurant_id,
              reward_type: "FREE_ITEM",
              stamp_count_before:
                applied.before?.stamp_count ?? STAMP_CARD_SIZE,
              rewards_earned: applied.card.rewards_earned,
            }),
          );
        }
        return applied;
      },
    );
    if (!result) return;

    await sharedAuditRepo.log(payload.sender_id, "gift_stamp_incremented", {
      gift_id: payload.gift_id,
      restaurant_id: payload.restaurant_id,
      stamp_count: result.card.stamp_count,
      total_orders: result.card.total_orders,
      reward_unlocked: result.reward_unlocked,
    });
  });
}
