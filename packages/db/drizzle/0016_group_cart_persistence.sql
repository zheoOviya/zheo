CREATE TABLE IF NOT EXISTS "group_cart_contributors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_cart_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"avatar_seed" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_carts" (
	"token" text PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_cart_contributors" ADD CONSTRAINT "group_cart_contributors_group_cart_id_group_carts_token_fk" FOREIGN KEY ("group_cart_id") REFERENCES "public"."group_carts"("token") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_cart_contributors" ADD CONSTRAINT "group_cart_contributors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_carts" ADD CONSTRAINT "group_carts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_carts" ADD CONSTRAINT "group_carts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_carts" ADD CONSTRAINT "group_carts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_cart_contributors_member_uq" ON "group_cart_contributors" USING btree ("group_cart_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_carts_order_uq" ON "group_carts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_carts_created_by_idx" ON "group_carts" USING btree ("created_by");