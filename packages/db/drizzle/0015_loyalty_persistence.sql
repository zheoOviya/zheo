CREATE TYPE "public"."loyalty_ledger_reason" AS ENUM('referral_bonus', 'pickup_cashback');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"reason" "loyalty_ledger_reason" NOT NULL,
	"balance_after" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_referral_codes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claimant_user_id" uuid NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"referral_code" text NOT NULL,
	"bonus_amount" numeric(10, 2) NOT NULL,
	"ip_address" text,
	"device_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_stamp_cards" (
	"user_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"stamp_count" integer DEFAULT 0 NOT NULL,
	"total_orders" integer DEFAULT 0 NOT NULL,
	"rewards_earned" integer DEFAULT 0 NOT NULL,
	"reward_type" text DEFAULT 'FREE_ITEM' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_stamp_cards_user_id_restaurant_id_pk" PRIMARY KEY("user_id","restaurant_id"),
	CONSTRAINT "loyalty_stamp_cards_reward_type_check" CHECK ("loyalty_stamp_cards"."reward_type" = 'FREE_ITEM')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_streaks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"best_streak" integer DEFAULT 0 NOT NULL,
	"last_pickup_day" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loyalty_wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_earned" numeric(12, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loyalty_ledger_user_created_idx" ON "loyalty_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_referral_codes_code_uq" ON "loyalty_referral_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_referrals_claimant_uq" ON "loyalty_referrals" USING btree ("claimant_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_referrals_ip_uq" ON "loyalty_referrals" USING btree ("ip_address") WHERE "loyalty_referrals"."ip_address" is not null and "loyalty_referrals"."ip_address" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_referrals_device_uq" ON "loyalty_referrals" USING btree ("device_fingerprint") WHERE "loyalty_referrals"."device_fingerprint" is not null and "loyalty_referrals"."device_fingerprint" <> '';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loyalty_referrals_referrer_idx" ON "loyalty_referrals" USING btree ("referrer_user_id");