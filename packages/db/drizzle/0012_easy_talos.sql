CREATE TYPE "public"."gift_status" AS ENUM('PENDING', 'ACTIVE', 'CLAIMED', 'FULFILLED', 'EXPIRED', 'REFUNDING', 'REFUNDED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"item_snapshot" jsonb NOT NULL,
	"price_paid" numeric(10, 2) NOT NULL,
	"message" text,
	"recipient_name" text,
	"claim_token" text NOT NULL,
	"claim_code" text NOT NULL,
	"status" "gift_status" DEFAULT 'PENDING' NOT NULL,
	"payment_id" uuid,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gifts_claim_token_unique" UNIQUE("claim_token")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" DROP CONSTRAINT "payments_order_id_orders_id_fk";
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "gift_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "gift_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gifts" ADD CONSTRAINT "gifts_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gifts" ADD CONSTRAINT "gifts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gifts" ADD CONSTRAINT "gifts_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gifts" ADD CONSTRAINT "gifts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gifts" ADD CONSTRAINT "gifts_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gifts_sender_idx" ON "gifts" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gifts_restaurant_idx" ON "gifts" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gifts_status_idx" ON "gifts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_gift_id_idx" ON "payments" USING btree ("gift_id");
