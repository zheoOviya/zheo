import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  loyalty_ledger,
  loyalty_referral_codes,
  loyalty_referrals,
  loyalty_stamp_cards,
  loyalty_streaks,
  loyalty_wallets,
} from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import { AppError } from "../../middleware/envelope";
import {
  MAX_REFERRAL_CODE_ATTEMPTS,
  deriveReferralCode,
  shiftUtcDay,
  type IncrementStampResult,
  type LoyaltyRepository,
  type LoyaltyWallet,
  type PickupStreak,
  type RecordPickupResult,
  type ReferralClaim,
  type StampCard,
  type WalletTransaction,
} from "../loyaltyRepository";

// ============================================
// Loyalty bounded-context repository (Drizzle/Postgres).
// Mirrors MemoryLoyaltyRepository semantics exactly. Money columns are
// numeric -> Number() on read / String() on write; timestamps are
// timestamptz -> .toISOString() on read / Date on write. Uses the shared
// deriveReferralCode helper so referral codes cannot diverge from Memory.
// ============================================

function pgErrorDetails(err: unknown): { code?: string; constraint?: string } {
  let cur = err as
    | { code?: unknown; constraint?: unknown; cause?: unknown }
    | undefined;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    if (typeof cur.code === "string") {
      return {
        code: cur.code,
        constraint: typeof cur.constraint === "string" ? cur.constraint : undefined,
      };
    }
    cur = cur.cause as typeof cur;
  }
  return {};
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorDetails(err).code === "23505";
}

export class DrizzleLoyaltyRepository implements LoyaltyRepository {
  constructor(private readonly db: DrizzleDb) {}

  // ---- row mappers ---------------------------------------------------------

  private mapReferralClaim(row: Record<string, unknown>): ReferralClaim {
    return {
      id: row.id as string,
      claimant_user_id: row.claimant_user_id as string,
      referrer_user_id: row.referrer_user_id as string,
      referral_code: row.referral_code as string,
      bonus_amount: Number(row.bonus_amount),
      ip_address: (row.ip_address as string | null) ?? null,
      device_fingerprint: (row.device_fingerprint as string | null) ?? null,
      created_at: (row.created_at as Date).toISOString(),
    };
  }

  private mapWallet(row: Record<string, unknown>): LoyaltyWallet {
    return {
      user_id: row.user_id as string,
      balance: Number(row.balance),
      total_earned: Number(row.total_earned),
    };
  }

  private mapTransaction(row: Record<string, unknown>): WalletTransaction {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      amount: Number(row.amount),
      reason: row.reason as WalletTransaction["reason"],
      balance_after: Number(row.balance_after),
      created_at: (row.created_at as Date).toISOString(),
    };
  }

  private mapStreak(row: Record<string, unknown>): PickupStreak {
    return {
      user_id: row.user_id as string,
      current_streak: Number(row.current_streak),
      best_streak: Number(row.best_streak),
      last_pickup_day: (row.last_pickup_day as string | null) ?? null,
      updated_at: (row.updated_at as Date).toISOString(),
    };
  }

  private mapStampCard(row: Record<string, unknown>): StampCard {
    return {
      user_id: row.user_id as string,
      restaurant_id: row.restaurant_id as string,
      stamp_count: Number(row.stamp_count),
      total_orders: Number(row.total_orders),
      rewards_earned: Number(row.rewards_earned),
      reward_type: row.reward_type as StampCard["reward_type"],
      updated_at: (row.updated_at as Date).toISOString(),
    };
  }

  private async rows(rowsPromise: unknown): Promise<Record<string, unknown>[]> {
    return (await rowsPromise) as Record<string, unknown>[];
  }

  /** Autocommit insert that ignores an expected unique violation, used only to
   *  lazily materialize a default row before its locking transaction. */
  private async ensureRow(
    table: unknown,
    values: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.insert(table).values(values);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  // ---- referral codes ------------------------------------------------------

  private async codeForUser(userId: string): Promise<string | null> {
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_referral_codes)
        .where(eq(loyalty_referral_codes.user_id, userId)),
    );
    return rows.length > 0 ? (rows[0]!.code as string) : null;
  }

  async getReferralCode(userId: string): Promise<string> {
    const existing = await this.codeForUser(userId);
    if (existing) return existing;

    for (let attempt = 0; attempt < MAX_REFERRAL_CODE_ATTEMPTS; attempt += 1) {
      const candidate = deriveReferralCode(userId, attempt);
      try {
        await this.db
          .insert(loyalty_referral_codes)
          .values({ user_id: userId, code: candidate });
        return candidate;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Either a same-user race (our row now exists) or the candidate is
        // owned by another user (advance to the next deterministic attempt).
        const mine = await this.codeForUser(userId);
        if (mine) return mine;
      }
    }
    throw new AppError(
      "REFERRAL_CODE_GENERATION_FAILED",
      "Could not allocate a unique referral code",
      500,
    );
  }

  async getReferrerByCode(code: string): Promise<string | null> {
    const normalized = code.trim().toUpperCase();
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_referral_codes)
        .where(eq(loyalty_referral_codes.code, normalized)),
    );
    return rows.length > 0 ? (rows[0]!.user_id as string) : null;
  }

  // ---- referral claims -----------------------------------------------------

  async hasClaimedByIp(ipAddress: string): Promise<boolean> {
    if (!ipAddress) return false;
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_referrals)
        .where(eq(loyalty_referrals.ip_address, ipAddress)),
    );
    return rows.length > 0;
  }

  async hasClaimedByDevice(deviceFingerprint: string): Promise<boolean> {
    if (!deviceFingerprint) return false;
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_referrals)
        .where(eq(loyalty_referrals.device_fingerprint, deviceFingerprint)),
    );
    return rows.length > 0;
  }

  async hasUserClaimed(userId: string): Promise<boolean> {
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_referrals)
        .where(eq(loyalty_referrals.claimant_user_id, userId)),
    );
    return rows.length > 0;
  }

  async recordClaim(
    claim: Omit<ReferralClaim, "id" | "created_at">,
  ): Promise<ReferralClaim> {
    const id = randomUUID();
    const now = new Date();
    try {
      await this.db.insert(loyalty_referrals).values({
        id,
        claimant_user_id: claim.claimant_user_id,
        referrer_user_id: claim.referrer_user_id,
        referral_code: claim.referral_code,
        bonus_amount: String(claim.bonus_amount),
        ip_address: claim.ip_address,
        device_fingerprint: claim.device_fingerprint,
        created_at: now,
      });
    } catch (err) {
      // Translate uniqueness races into the exact service-level errors so a
      // concurrent duplicate never surfaces as an INTERNAL_ERROR 500.
      const e = pgErrorDetails(err);
      if (e.code === "23505") {
        if (e.constraint === "loyalty_referrals_claimant_uq") {
          throw new AppError(
            "REFERRAL_ALREADY_USED",
            "This account has already used a referral code",
            400,
          );
        }
        if (e.constraint === "loyalty_referrals_ip_uq") {
          throw new AppError(
            "FRAUD_DETECTED",
            "This network has already claimed a referral",
            403,
          );
        }
        if (e.constraint === "loyalty_referrals_device_uq") {
          throw new AppError(
            "FRAUD_DETECTED",
            "This device has already claimed a referral",
            403,
          );
        }
      }
      throw err;
    }
    return {
      id,
      claimant_user_id: claim.claimant_user_id,
      referrer_user_id: claim.referrer_user_id,
      referral_code: claim.referral_code,
      bonus_amount: claim.bonus_amount,
      ip_address: claim.ip_address,
      device_fingerprint: claim.device_fingerprint,
      created_at: now.toISOString(),
    };
  }

  async getReferralClaimsByReferrer(
    referrerUserId: string,
  ): Promise<ReferralClaim[]> {
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_referrals)
        .where(eq(loyalty_referrals.referrer_user_id, referrerUserId)),
    );
    return rows
      .map((row) => this.mapReferralClaim(row))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getReferralClaimsByClaimant(
    claimantUserId: string,
  ): Promise<ReferralClaim[]> {
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_referrals)
        .where(eq(loyalty_referrals.claimant_user_id, claimantUserId)),
    );
    return rows
      .map((row) => this.mapReferralClaim(row))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // ---- wallet + ledger -----------------------------------------------------

  async getWallet(userId: string): Promise<LoyaltyWallet> {
    await this.ensureRow(loyalty_wallets, {
      user_id: userId,
      balance: "0",
      total_earned: "0",
    });
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_wallets)
        .where(eq(loyalty_wallets.user_id, userId)),
    );
    return this.mapWallet(rows[0]!);
  }

  async creditWallet(
    userId: string,
    amount: number,
    reason: WalletTransaction["reason"],
  ): Promise<LoyaltyWallet> {
    await this.ensureRow(loyalty_wallets, {
      user_id: userId,
      balance: "0",
      total_earned: "0",
    });
    return this.db.transaction(async (tx) => {
      const locked = await this.rows(
        (tx as unknown as DrizzleDb)
          .select()
          .from(loyalty_wallets)
          .where(eq(loyalty_wallets.user_id, userId))
          .for("update"),
      );
      const current = this.mapWallet(locked[0]!);
      const next: LoyaltyWallet = {
        user_id: userId,
        balance: current.balance + amount,
        total_earned: current.total_earned + amount,
      };
      const now = new Date();
      await (tx as unknown as DrizzleDb)
        .update(loyalty_wallets)
        .set({
          balance: String(next.balance),
          total_earned: String(next.total_earned),
        })
        .where(eq(loyalty_wallets.user_id, userId));
      await (tx as unknown as DrizzleDb).insert(loyalty_ledger).values({
        id: randomUUID(),
        user_id: userId,
        amount: String(amount),
        reason,
        balance_after: String(next.balance),
        created_at: now,
      });
      return next;
    });
  }

  async getWalletTransactions(userId: string): Promise<WalletTransaction[]> {
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_ledger)
        .where(eq(loyalty_ledger.user_id, userId)),
    );
    return rows
      .map((row) => this.mapTransaction(row))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // ---- streak --------------------------------------------------------------

  async getStreak(userId: string): Promise<PickupStreak> {
    await this.ensureRow(loyalty_streaks, {
      user_id: userId,
      current_streak: 0,
      best_streak: 0,
      last_pickup_day: null,
      updated_at: new Date(),
    });
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_streaks)
        .where(eq(loyalty_streaks.user_id, userId)),
    );
    return this.mapStreak(rows[0]!);
  }

  async recordPickup(userId: string, day: string): Promise<RecordPickupResult> {
    await this.ensureRow(loyalty_streaks, {
      user_id: userId,
      current_streak: 0,
      best_streak: 0,
      last_pickup_day: null,
      updated_at: new Date(),
    });
    return this.db.transaction(async (tx) => {
      const rows = await this.rows(
        (tx as unknown as DrizzleDb)
          .select()
          .from(loyalty_streaks)
          .where(eq(loyalty_streaks.user_id, userId))
          .for("update"),
      );
      const streak = this.mapStreak(rows[0]!);

      if (streak.last_pickup_day === day) {
        return { streak, advanced: false, badge_unlocked: false };
      }

      const yesterday = shiftUtcDay(day, -1);
      if (streak.last_pickup_day === yesterday) {
        streak.current_streak += 1;
      } else {
        streak.current_streak = 1;
      }
      if (streak.current_streak > streak.best_streak) {
        streak.best_streak = streak.current_streak;
      }
      streak.last_pickup_day = day;
      const now = new Date();
      streak.updated_at = now.toISOString();
      const badgeUnlocked = streak.current_streak % 7 === 0;

      await (tx as unknown as DrizzleDb)
        .update(loyalty_streaks)
        .set({
          current_streak: streak.current_streak,
          best_streak: streak.best_streak,
          last_pickup_day: day,
          updated_at: now,
        })
        .where(eq(loyalty_streaks.user_id, userId));

      return { streak, advanced: true, badge_unlocked: badgeUnlocked };
    });
  }

  // ---- stamp cards ---------------------------------------------------------

  async getStampCard(
    userId: string,
    restaurantId: string,
  ): Promise<StampCard | null> {
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_stamp_cards)
        .where(
          and(
            eq(loyalty_stamp_cards.user_id, userId),
            eq(loyalty_stamp_cards.restaurant_id, restaurantId),
          ),
        ),
    );
    return rows.length > 0 ? this.mapStampCard(rows[0]!) : null;
  }

  async getStampCards(userId: string): Promise<StampCard[]> {
    const rows = await this.rows(
      this.db
        .select()
        .from(loyalty_stamp_cards)
        .where(eq(loyalty_stamp_cards.user_id, userId)),
    );
    return rows
      .map((row) => this.mapStampCard(row))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async incrementStamp(
    userId: string,
    restaurantId: string,
  ): Promise<IncrementStampResult> {
    await this.ensureRow(loyalty_stamp_cards, {
      user_id: userId,
      restaurant_id: restaurantId,
      stamp_count: 0,
      total_orders: 0,
      rewards_earned: 0,
      reward_type: "FREE_ITEM",
      updated_at: new Date(),
    });
    return this.db.transaction(async (tx) => {
      const rows = await this.rows(
        (tx as unknown as DrizzleDb)
          .select()
          .from(loyalty_stamp_cards)
          .where(
            and(
              eq(loyalty_stamp_cards.user_id, userId),
              eq(loyalty_stamp_cards.restaurant_id, restaurantId),
            ),
          )
          .for("update"),
      );
      const current = this.mapStampCard(rows[0]!);

      let stampCount = current.stamp_count + 1;
      let rewardsEarned = current.rewards_earned;
      let rewardUnlocked = false;
      if (stampCount >= 10) {
        stampCount = 0;
        rewardsEarned += 1;
        rewardUnlocked = true;
      }

      const now = new Date();
      const card: StampCard = {
        user_id: userId,
        restaurant_id: restaurantId,
        stamp_count: stampCount,
        total_orders: current.total_orders + 1,
        rewards_earned: rewardsEarned,
        reward_type: "FREE_ITEM",
        updated_at: now.toISOString(),
      };
      await (tx as unknown as DrizzleDb)
        .update(loyalty_stamp_cards)
        .set({
          stamp_count: card.stamp_count,
          total_orders: card.total_orders,
          rewards_earned: card.rewards_earned,
          updated_at: now,
        })
        .where(
          and(
            eq(loyalty_stamp_cards.user_id, userId),
            eq(loyalty_stamp_cards.restaurant_id, restaurantId),
          ),
        );

      return { card, reward_unlocked: rewardUnlocked };
    });
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
