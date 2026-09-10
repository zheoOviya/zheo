import { sql } from "drizzle-orm";
import {
  check,
  decimal,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ============================================
// Loyalty bounded context (L05 Refer & Earn, L01 Stamp Cards,
// O12 Wallet & Cashback, L02 Pickup Streak).
//
// These tables duplicate the in-memory loyalty stores so Postgres mode
// survives restarts. No foreign keys are declared (matching the
// support_tickets.user_id precedent): rows are created lazily from JWT
// user ids and restaurant ids that already exist upstream.
// ============================================

export const loyaltyLedgerReasonEnum = pgEnum("loyalty_ledger_reason", [
  "referral_bonus",
  "pickup_cashback",
]);

/** Deterministic short referral code per user. UNIQUE(code) guarantees a code
 *  resolves to exactly one referrer; PK(user_id) guarantees one code per user. */
export const loyalty_referral_codes = pgTable(
  "loyalty_referral_codes",
  {
    user_id: uuid("user_id").primaryKey(),
    code: text("code").notNull(),
  },
  (table) => ({
    codeUq: uniqueIndex("loyalty_referral_codes_code_uq").on(table.code),
  }),
);

/** L05 referral claims. Blank ip/device values are excluded from the partial
 *  uniques so header-less clients can never collide. */
export const loyalty_referrals = pgTable(
  "loyalty_referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimant_user_id: uuid("claimant_user_id").notNull(),
    referrer_user_id: uuid("referrer_user_id").notNull(),
    referral_code: text("referral_code").notNull(),
    bonus_amount: decimal("bonus_amount", { precision: 10, scale: 2 }).notNull(),
    ip_address: text("ip_address"),
    device_fingerprint: text("device_fingerprint"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    claimantUq: uniqueIndex("loyalty_referrals_claimant_uq").on(
      table.claimant_user_id,
    ),
    ipUq: uniqueIndex("loyalty_referrals_ip_uq")
      .on(table.ip_address)
      .where(sql`${table.ip_address} is not null and ${table.ip_address} <> ''`),
    deviceUq: uniqueIndex("loyalty_referrals_device_uq")
      .on(table.device_fingerprint)
      .where(
        sql`${table.device_fingerprint} is not null and ${table.device_fingerprint} <> ''`,
      ),
    referrerIdx: index("loyalty_referrals_referrer_idx").on(
      table.referrer_user_id,
    ),
  }),
);

/** O12 wallet balance. */
export const loyalty_wallets = pgTable("loyalty_wallets", {
  user_id: uuid("user_id").primaryKey(),
  balance: decimal("balance", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  total_earned: decimal("total_earned", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
});

/** O12 double-entry wallet ledger (append-only). */
export const loyalty_ledger = pgTable(
  "loyalty_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id").notNull(),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    reason: loyaltyLedgerReasonEnum("reason").notNull(),
    balance_after: decimal("balance_after", { precision: 12, scale: 2 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index("loyalty_ledger_user_created_idx").on(
      table.user_id,
      table.created_at,
    ),
  }),
);

/** L02 pickup streak, keyed on UTC YYYY-MM-DD pickup days. */
export const loyalty_streaks = pgTable("loyalty_streaks", {
  user_id: uuid("user_id").primaryKey(),
  current_streak: integer("current_streak").notNull().default(0),
  best_streak: integer("best_streak").notNull().default(0),
  last_pickup_day: text("last_pickup_day"),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** L01 per-restaurant stamp card. */
export const loyalty_stamp_cards = pgTable(
  "loyalty_stamp_cards",
  {
    user_id: uuid("user_id").notNull(),
    restaurant_id: uuid("restaurant_id").notNull(),
    stamp_count: integer("stamp_count").notNull().default(0),
    total_orders: integer("total_orders").notNull().default(0),
    rewards_earned: integer("rewards_earned").notNull().default(0),
    reward_type: text("reward_type").notNull().default("FREE_ITEM"),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.user_id, table.restaurant_id] }),
    rewardTypeCheck: check(
      "loyalty_stamp_cards_reward_type_check",
      sql`${table.reward_type} = 'FREE_ITEM'`,
    ),
  }),
);
