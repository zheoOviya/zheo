ALTER TYPE "public"."payment_status" ADD VALUE IF NOT EXISTS 'INITIATING';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE IF NOT EXISTS 'FAILED_INITIATION';--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "provider_transaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "receipt" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "lease_owner" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_order_unique" ON "payments" USING btree ("order_id") WHERE ("order_id" IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_gift_unique" ON "payments" USING btree ("gift_id") WHERE ("gift_id" IS NOT NULL);
