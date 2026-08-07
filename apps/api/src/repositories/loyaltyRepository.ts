import { randomUUID } from "node:crypto";

// ============================================
// Loyalty context repository (loyalty bounded context)
// L05 Refer & Earn + L01 Stamp Cards.
// Dedicated referral_claims + stamp_cards stores so fraud
// screening never scans the generic audit_logs table.
// ============================================

export interface ReferralClaim {
  id: string;
  claimant_user_id: string;
  referrer_user_id: string;
  referral_code: string;
  bonus_amount: number;
  ip_address: string | null;
  device_fingerprint: string | null;
  created_at: string;
}

export interface LoyaltyWallet {
  user_id: string;
  balance: number;
  total_earned: number;
}

/** O12 double-entry wallet ledger row (append-only). */
export interface WalletTransaction {
  id: string;
  user_id: string;
  amount: number;
  reason: "referral_bonus" | "pickup_cashback";
  balance_after: number;
  created_at: string;
}

/** L02 consecutive-pickup streak, keyed on UTC YYYY-MM-DD pickup days. */
export interface PickupStreak {
  user_id: string;
  current_streak: number;
  best_streak: number;
  last_pickup_day: string | null;
  updated_at: string;
}

export interface RecordPickupResult {
  streak: PickupStreak;
  /** True when the streak advanced (new consecutive day), false if idempotent. */
  advanced: boolean;
  /** True when current_streak is an exact multiple of 7 -> badge + coupon. */
  badge_unlocked: boolean;
}

export interface StampCard {
  user_id: string;
  restaurant_id: string;
  stamp_count: number;
  total_orders: number;
  rewards_earned: number;
  reward_type: "FREE_ITEM";
  updated_at: string;
}

export interface IncrementStampResult {
  card: StampCard;
  reward_unlocked: boolean;
}

export interface LoyaltyRepository {
  getReferralCode(userId: string): Promise<string>;
  getReferrerByCode(code: string): Promise<string | null>;
  hasClaimedByIp(ipAddress: string): Promise<boolean>;
  hasClaimedByDevice(deviceFingerprint: string): Promise<boolean>;
  hasUserClaimed(userId: string): Promise<boolean>;
  recordClaim(claim: Omit<ReferralClaim, "id" | "created_at">): Promise<ReferralClaim>;
  getWallet(userId: string): Promise<LoyaltyWallet>;
  creditWallet(
    userId: string,
    amount: number,
    reason: "referral_bonus" | "pickup_cashback",
  ): Promise<LoyaltyWallet>;
  getWalletTransactions(userId: string): Promise<WalletTransaction[]>;
  getStreak(userId: string): Promise<PickupStreak>;
  /** L02: advances or resets the streak for the given UTC day. */
  recordPickup(userId: string, day: string): Promise<RecordPickupResult>;
  getStampCard(userId: string, restaurantId: string): Promise<StampCard | null>;
  getStampCards(userId: string): Promise<StampCard[]>;
  incrementStamp(
    userId: string,
    restaurantId: string,
  ): Promise<IncrementStampResult>;
  _reset(): void;
}

function generateReferralCode(userId: string): string {
  // Deterministic short code from the user id so a given user always gets
  // the same code across sessions (fits the 3-tap copy-flow).
  let hash = 0;
  const raw = userId.replace(/-/g, "");
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i);
    hash = (hash << 5) - hash + ch;
    hash |= 0;
  }
  return `SNKZ-${Math.abs(hash).toString(36).toUpperCase().slice(0, 6)}`;
}

export class MemoryLoyaltyRepository implements LoyaltyRepository {
  private readonly referralCodes = new Map<string, string>();
  private claims: ReferralClaim[] = [];
  private readonly wallets = new Map<string, LoyaltyWallet>();
  private transactions: WalletTransaction[] = [];
  private readonly streaks = new Map<string, PickupStreak>();
  private readonly stampCards = new Map<string, StampCard>();

  private stampKey(userId: string, restaurantId: string): string {
    return `${userId}|${restaurantId}`;
  }

  async getReferralCode(userId: string): Promise<string> {
    const existing = this.referralCodes.get(userId);
    if (existing) return existing;
    const code = generateReferralCode(userId);
    this.referralCodes.set(userId, code);
    return code;
  }

  async getReferrerByCode(code: string): Promise<string | null> {
    const normalized = code.trim().toUpperCase();
    for (const [userId, userCode] of this.referralCodes.entries()) {
      if (userCode.toUpperCase() === normalized) return userId;
    }
    return null;
  }

  async hasClaimedByIp(ipAddress: string): Promise<boolean> {
    if (!ipAddress) return false;
    return this.claims.some((c) => c.ip_address === ipAddress);
  }

  async hasClaimedByDevice(deviceFingerprint: string): Promise<boolean> {
    if (!deviceFingerprint) return false;
    return this.claims.some((c) => c.device_fingerprint === deviceFingerprint);
  }

  async hasUserClaimed(userId: string): Promise<boolean> {
    return this.claims.some((c) => c.claimant_user_id === userId);
  }

  async recordClaim(
    claim: Omit<ReferralClaim, "id" | "created_at">,
  ): Promise<ReferralClaim> {
    const entry: ReferralClaim = {
      ...claim,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.claims.push(entry);
    return entry;
  }

  async getWallet(userId: string): Promise<LoyaltyWallet> {
    const existing = this.wallets.get(userId);
    if (existing) return existing;
    const wallet: LoyaltyWallet = { user_id: userId, balance: 0, total_earned: 0 };
    this.wallets.set(userId, wallet);
    return wallet;
  }

  async creditWallet(
    userId: string,
    amount: number,
    reason: "referral_bonus" | "pickup_cashback",
  ): Promise<LoyaltyWallet> {
    const wallet = await this.getWallet(userId);
    wallet.balance += amount;
    wallet.total_earned += amount;
    this.wallets.set(userId, wallet);
    this.transactions.push({
      id: randomUUID(),
      user_id: userId,
      amount,
      reason,
      balance_after: wallet.balance,
      created_at: new Date().toISOString(),
    });
    return wallet;
  }

  async getWalletTransactions(userId: string): Promise<WalletTransaction[]> {
    return this.transactions
      .filter((t) => t.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getStreak(userId: string): Promise<PickupStreak> {
    const existing = this.streaks.get(userId);
    if (existing) return existing;
    const streak: PickupStreak = {
      user_id: userId,
      current_streak: 0,
      best_streak: 0,
      last_pickup_day: null,
      updated_at: new Date().toISOString(),
    };
    this.streaks.set(userId, streak);
    return streak;
  }

  async recordPickup(userId: string, day: string): Promise<RecordPickupResult> {
    const streak = await this.getStreak(userId);
    if (streak.last_pickup_day === day) {
      // Idempotent: the consumer picked up on this day already.
      return { streak, advanced: false, badge_unlocked: false };
    }

    const yesterday = this.shiftDay(day, -1);
    let advanced = true;
    let badgeUnlocked = false;
    if (streak.last_pickup_day === yesterday) {
      streak.current_streak += 1;
    } else {
      streak.current_streak = 1;
    }
    if (streak.current_streak > streak.best_streak) {
      streak.best_streak = streak.current_streak;
    }
    streak.last_pickup_day = day;
    streak.updated_at = new Date().toISOString();
    if (streak.current_streak % 7 === 0) {
      badgeUnlocked = true;
    }
    this.streaks.set(userId, streak);
    return { streak, advanced, badge_unlocked: badgeUnlocked };
  }

  /** Rolls a UTC YYYY-MM-DD day forward/backward by `delta` days. */
  private shiftDay(day: string, delta: number): string {
    const [yRaw, mRaw, dRaw] = day.split("-");
    const y = Number(yRaw) || 0;
    const m = Number(mRaw) || 1;
    const d = Number(dRaw) || 1;
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  }

  async getStampCard(
    userId: string,
    restaurantId: string,
  ): Promise<StampCard | null> {
    return this.stampCards.get(this.stampKey(userId, restaurantId)) ?? null;
  }

  async getStampCards(userId: string): Promise<StampCard[]> {
    return Array.from(this.stampCards.values())
      .filter((c) => c.user_id === userId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async incrementStamp(
    userId: string,
    restaurantId: string,
  ): Promise<IncrementStampResult> {
    const key = this.stampKey(userId, restaurantId);
    const existing = this.stampCards.get(key);
    const nextCount = (existing?.stamp_count ?? 0) + 1;
    const card: StampCard = {
      user_id: userId,
      restaurant_id: restaurantId,
      stamp_count: nextCount,
      total_orders: (existing?.total_orders ?? 0) + 1,
      rewards_earned: existing?.rewards_earned ?? 0,
      reward_type: "FREE_ITEM",
      updated_at: new Date().toISOString(),
    };

    let rewardUnlocked = false;
    if (card.stamp_count >= 10) {
      card.stamp_count = 0;
      card.rewards_earned += 1;
      rewardUnlocked = true;
    }
    this.stampCards.set(key, card);
    return { card, reward_unlocked: rewardUnlocked };
  }

  /** Resets the store between tests. */
  _reset(): void {
    this.referralCodes.clear();
    this.claims = [];
    this.wallets.clear();
    this.transactions = [];
    this.streaks.clear();
    this.stampCards.clear();
  }
}
