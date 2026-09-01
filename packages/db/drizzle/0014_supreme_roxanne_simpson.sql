CREATE TYPE "public"."dine_in_order_status" AS ENUM('PLACED', 'PREPARING', 'READY_TO_SERVE', 'SERVED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."dining_session_status" AS ENUM('OPEN', 'ACTIVE', 'BILL_REQUESTED', 'PAYMENT_PENDING', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."service_request_status" AS ENUM('PENDING', 'ACKNOWLEDGED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."service_request_type" AS ENUM('WATER', 'EXTRA_PLATE', 'CUTLERY', 'TISSUE', 'CLEAN_TABLE', 'CALL_STAFF', 'BRING_BILL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."staff_assignment_status" AS ENUM('ACTIVE', 'ENDED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dine_in_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dine_in_order_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_price" numeric(10, 2) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"customizations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"customization_total" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"item_subtotal" numeric(10, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dine_in_order_items_quantity_positive" CHECK ("dine_in_order_items"."quantity" > 0),
	CONSTRAINT "dine_in_order_items_subtotal_non_negative" CHECK ("dine_in_order_items"."item_subtotal" >= 0),
	CONSTRAINT "dine_in_order_items_custom_total_non_negative" CHECK ("dine_in_order_items"."customization_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dine_in_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"placed_by" uuid NOT NULL,
	"status" "dine_in_order_status" DEFAULT 'PLACED' NOT NULL,
	"total_amount" numeric(10, 2) NOT NULL,
	"notes" text,
	"served_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dine_in_orders_total_non_negative" CHECK ("dine_in_orders"."total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dine_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dine_zones_name_not_empty" CHECK ("dine_zones"."name" <> '')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dining_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status" "dining_session_status" DEFAULT 'OPEN' NOT NULL,
	"bill_requested_at" timestamp with time zone,
	"payment_pending_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dining_sessions_time_order" CHECK ("dining_sessions"."created_at" <= "dining_sessions"."updated_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "restaurant_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"zone_id" uuid,
	"label" text NOT NULL,
	"table_token" text NOT NULL,
	"seat_count" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurant_tables_label_not_empty" CHECK ("restaurant_tables"."label" <> ''),
	CONSTRAINT "restaurant_tables_token_length" CHECK (length("restaurant_tables"."table_token") >= 32),
	CONSTRAINT "restaurant_tables_seat_count_positive" CHECK ("restaurant_tables"."seat_count" IS NULL OR "restaurant_tables"."seat_count" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"request_type" "service_request_type" NOT NULL,
	"status" "service_request_status" DEFAULT 'PENDING' NOT NULL,
	"note" text,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_requests_ack_consistency" CHECK (("service_requests"."acknowledged_by" IS NULL) = ("service_requests"."acknowledged_at" IS NULL)),
	CONSTRAINT "service_requests_complete_consistency" CHECK (("service_requests"."completed_by" IS NULL) = ("service_requests"."completed_at" IS NULL)),
	CONSTRAINT "service_requests_note_for_other" CHECK ("service_requests"."request_type" <> 'OTHER' OR "service_requests"."note" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"food_subtotal" numeric(10, 2) NOT NULL,
	"packaging_fee" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"gst_food" numeric(10, 2) NOT NULL,
	"gst_packaging" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"total_amount" numeric(10, 2) NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_bills_arithmetic" CHECK ("session_bills"."total_amount" = "session_bills"."food_subtotal" + "session_bills"."packaging_fee" + "session_bills"."gst_food" + "session_bills"."gst_packaging"),
	CONSTRAINT "session_bills_non_negative" CHECK ("session_bills"."food_subtotal" >= 0 AND "session_bills"."packaging_fee" >= 0 AND "session_bills"."gst_food" >= 0 AND "session_bills"."gst_packaging" >= 0 AND "session_bills"."total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"assigned_by" uuid,
	"zone_id" uuid,
	"status" "staff_assignment_status" DEFAULT 'ACTIVE' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "staff_assignments_time_order" CHECK ("staff_assignments"."ended_at" IS NULL OR "staff_assignments"."ended_at" >= "staff_assignments"."assigned_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dine_in_orders_restaurant_id_idx" ON "dine_in_orders" USING btree ("restaurant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dine_zones_restaurant_id_idx" ON "dine_zones" USING btree ("restaurant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dining_sessions_restaurant_id_idx" ON "dining_sessions" USING btree ("restaurant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "restaurant_tables_restaurant_id_idx" ON "restaurant_tables" USING btree ("restaurant_id","id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_in_order_items" ADD CONSTRAINT "dine_in_order_items_dine_in_order_id_dine_in_orders_id_fk" FOREIGN KEY ("dine_in_order_id") REFERENCES "public"."dine_in_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_in_order_items" ADD CONSTRAINT "dine_in_order_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_in_order_items" ADD CONSTRAINT "dine_in_order_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_in_order_items" ADD CONSTRAINT "dine_in_order_items_restaurant_id_dine_in_order_id_dine_in_orders_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","dine_in_order_id") REFERENCES "public"."dine_in_orders"("restaurant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_in_orders" ADD CONSTRAINT "dine_in_orders_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_in_orders" ADD CONSTRAINT "dine_in_orders_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_in_orders" ADD CONSTRAINT "dine_in_orders_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_in_orders" ADD CONSTRAINT "dine_in_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_in_orders" ADD CONSTRAINT "dine_in_orders_restaurant_id_session_id_dining_sessions_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","session_id") REFERENCES "public"."dining_sessions"("restaurant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dine_zones" ADD CONSTRAINT "dine_zones_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_table_id_restaurant_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_restaurant_id_table_id_restaurant_tables_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","table_id") REFERENCES "public"."restaurant_tables"("restaurant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_restaurant_id_zone_id_dine_zones_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","zone_id") REFERENCES "public"."dine_zones"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_restaurant_id_session_id_dining_sessions_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","session_id") REFERENCES "public"."dining_sessions"("restaurant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_bills" ADD CONSTRAINT "session_bills_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_bills" ADD CONSTRAINT "session_bills_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_bills" ADD CONSTRAINT "session_bills_restaurant_id_session_id_dining_sessions_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","session_id") REFERENCES "public"."dining_sessions"("restaurant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_staff_user_id_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_restaurant_id_session_id_dining_sessions_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","session_id") REFERENCES "public"."dining_sessions"("restaurant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_restaurant_id_zone_id_dine_zones_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","zone_id") REFERENCES "public"."dine_zones"("restaurant_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dine_in_order_items_order_idx" ON "dine_in_order_items" USING btree ("dine_in_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dine_in_order_items_menu_item_idx" ON "dine_in_order_items" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dine_in_orders_session_idx" ON "dine_in_orders" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dine_in_orders_restaurant_status_idx" ON "dine_in_orders" USING btree ("restaurant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dine_in_orders_created_idx" ON "dine_in_orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dine_zones_restaurant_idx" ON "dine_zones" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dine_zones_restaurant_name_idx" ON "dine_zones" USING btree ("restaurant_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dining_sessions_table_idx" ON "dining_sessions" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dining_sessions_restaurant_status_idx" ON "dining_sessions" USING btree ("restaurant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dining_sessions_owner_idx" ON "dining_sessions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dining_sessions_created_idx" ON "dining_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dining_sessions_live_table_idx" ON "dining_sessions" USING btree ("table_id") WHERE "dining_sessions"."status" IN ('OPEN', 'ACTIVE', 'BILL_REQUESTED', 'PAYMENT_PENDING');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "restaurant_tables_restaurant_idx" ON "restaurant_tables" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "restaurant_tables_zone_idx" ON "restaurant_tables" USING btree ("zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "restaurant_tables_restaurant_label_idx" ON "restaurant_tables" USING btree ("restaurant_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "restaurant_tables_table_token_idx" ON "restaurant_tables" USING btree ("table_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_requests_session_idx" ON "service_requests" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_requests_restaurant_status_idx" ON "service_requests" USING btree ("restaurant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_requests_requested_by_idx" ON "service_requests" USING btree ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_bills_session_idx" ON "session_bills" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_assignments_staff_active_idx" ON "staff_assignments" USING btree ("staff_user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_assignments_session_idx" ON "staff_assignments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_assignments_restaurant_status_idx" ON "staff_assignments" USING btree ("restaurant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_assignments_active_session_idx" ON "staff_assignments" USING btree ("session_id") WHERE "staff_assignments"."status" = 'ACTIVE';