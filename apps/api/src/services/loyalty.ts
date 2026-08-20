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
import { logger } from "../lib/logger";

// ============================================
// Loyalty context service (loyalty bounded context)
// L05 Refer & Earn with IP + device-fingerprint fraud
// prevention, and L01 per-restaurant Stamp Cards driven
// by the OrderPickedUp event.
// ============================================

export const REFERRAL_BONUS = 50;
export const STAMP_CARD_SIZE = 10;

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
  ) {}

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

    await this.repo.recordClaim({
      claimant_user_id: claimantUserId,
      referrer_user_id: referrerUserId,
      referral_code: referralCode.trim().toUpperCase(),
      bonus_amount: REFERRAL_BONUS,
      ip_address: ipAddress,
      device_fingerprint: deviceFingerprint,
    });

    // Rs 50 for the referrer AND Rs 50 for the claimant.
    await this.repo.creditWallet(referrerUserId, REFERRAL_BONUS, "referral_bonus");
    const claimantWallet = await this.repo.creditWallet(
      claimantUserId,
      REFERRAL_BONUS,
      "referral_bonus",
    );

    await sharedAuditRepo.log(claimantUserId, "referral_applied", {
      referral_code: referralCode.trim().toUpperCase(),
      referrer_user_id: referrerUserId,
      bonus_amount: REFERRAL_BONUS,
      ip_address: ipAddress,
    });

    await emit(
      createEventEnvelope("ReferralClaimed", claimantUserId, {
        referrer_user_id: referrerUserId,
        claimant_user_id: claimantUserId,
        referral_code: referralCode.trim().toUpperCase(),
        bonus_amount: REFERRAL_BONUS,
        ip_address: ipAddress ?? undefined,
        device_fingerprint: deviceFingerprint ?? undefined,
      }),
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

  /**
   * OrderPickedUp hook. Increments the user-restaurant stamp card. On the
   * 10th pickup the card unlocks a free item, resets to 0, and emits
   * StampCardRewardUnlocked for the notification layer.
   */
  async onOrderPickedUp(orderId: string): Promise<StampCard | null> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) return null;

    const before = await this.repo.getStampCard(order.user_id, order.restaurant_id);
    const { card, reward_unlocked } = await this.repo.incrementStamp(
      order.user_id,
      order.restaurant_id,
    );

    await sharedAuditRepo.log(order.user_id, "stamp_incremented", {
      order_id: order.id,
      restaurant_id: order.restaurant_id,
      stamp_count: card.stamp_count,
      total_orders: card.total_orders,
      reward_unlocked,
    });

    if (reward_unlocked) {
      await sharedAuditRepo.log(order.user_id, "stamp_card_reward_unlocked", {
        order_id: order.id,
        restaurant_id: order.restaurant_id,
        reward_type: "FREE_ITEM",
        stamp_count_before: before?.stamp_count ?? STAMP_CARD_SIZE,
        rewards_earned: card.rewards_earned,
      });
      await emit(
        createEventEnvelope("StampCardRewardUnlocked", order.user_id, {
          user_id: order.user_id,
          restaurant_id: order.restaurant_id,
          reward_type: "FREE_ITEM",
          stamp_count_before: before?.stamp_count ?? STAMP_CARD_SIZE,
          rewards_earned: card.rewards_earned,
        }),
      );
    }

    return card;
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
    const before = await this.repo.getStampCard(event.sender_id, event.restaurant_id);
    const { card, reward_unlocked } = await this.repo.incrementStamp(
      event.sender_id,
      event.restaurant_id,
    );

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
  onEvent("OrderPickedUp", async (event) => {
    const payload = event.payload as { order_id: string };
    await loyaltyService.onOrderPickedUp(payload.order_id);
  });
  onEvent("GiftFulfilled", async (event) => {
    const payload = event.payload as {
      gift_id: string;
      sender_id: string;
      restaurant_id: string;
    };
    await loyaltyService.onGiftFulfilled(payload);
  });
}
