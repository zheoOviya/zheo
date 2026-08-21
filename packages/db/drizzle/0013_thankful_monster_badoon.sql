DO $$ BEGIN
 ALTER TABLE "gifts" DROP CONSTRAINT "gifts_payment_id_payments_id_fk";
EXCEPTION
 WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "gifts" ADD COLUMN IF NOT EXISTS "redeemed_order_id" uuid;--> statement-breakpoint
ALTER TABLE "gifts" ADD COLUMN IF NOT EXISTS "refund_requested_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_exactly_one_target" CHECK ((order_id IS NOT NULL AND gift_id IS NULL) OR (order_id IS NULL AND gift_id IS NOT NULL));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;