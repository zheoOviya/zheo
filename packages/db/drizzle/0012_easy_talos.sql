CREATE TYPE "public"."gift_status" AS ENUM('PENDING', 'ACTIVE', 'CLAIMED', 'FULFILLED', 'EXPIRED', 'REFUNDING', 'REFUNDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."vendor_application_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."vendor_application_type" AS ENUM('SINGLE', 'CHAIN');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."user_role_scope" AS ENUM('platform', 'chain', 'restaurant');--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'PENDING_VENDOR' BEFORE 'VENDOR_OWNER';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE IF NOT EXISTS "kill_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"switch_name" text NOT NULL,
	"is_triggered" boolean DEFAULT false NOT NULL,
	"threshold_value" double precision NOT NULL,
	"current_value" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kill_switches_switch_name_unique" UNIQUE("switch_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"priority" "support_ticket_priority" DEFAULT 'MEDIUM' NOT NULL,
	"status" "support_ticket_status" DEFAULT 'OPEN' NOT NULL,
	"assigned_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"gst_number" text NOT NULL,
	"fssai_license" text NOT NULL,
	"phone" text NOT NULL,
	"contact_email" text,
	"address" text,
	"city" text,
	"lat" double precision,
	"lng" double precision,
	"commission_rate" numeric(5, 2) DEFAULT '0.08' NOT NULL,
	"status" "vendor_application_status" DEFAULT 'PENDING' NOT NULL,
	"type" "vendor_application_type" DEFAULT 'SINGLE' NOT NULL,
	"outlet_count" integer DEFAULT 1 NOT NULL,
	"rejection_reason" text,
	"reviewer_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"to_address" text NOT NULL,
	"body" text NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope_type" "user_role_scope" NOT NULL,
	"scope_id" uuid,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "pos_item_id" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "spice_level" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "chain_id" uuid;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "lat" double precision;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "lng" double precision;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "pickup_eta_min" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "rating" double precision;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "cuisines" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "price_for_one" integer;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "cover_image" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "gift_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_catering" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "headcount" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "scheduled_pickup_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "gift_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chains" ADD CONSTRAINT "chains_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
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
DO $$ BEGIN
 ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chains_owner_idx" ON "chains" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gifts_sender_idx" ON "gifts" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gifts_restaurant_idx" ON "gifts" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gifts_status_idx" ON "gifts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_user_idx" ON "support_tickets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_priority_idx" ON "support_tickets" USING btree ("priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_applications_applicant_idx" ON "vendor_applications" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_applications_status_idx" ON "vendor_applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_status_next_idx" ON "notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_scope_idx" ON "user_roles" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_roles_membership_idx" ON "user_roles" USING btree ("user_id","scope_type","scope_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_items_pos_item_idx" ON "menu_items" USING btree ("restaurant_id","pos_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "restaurants_chain_idx" ON "restaurants" USING btree ("chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_restaurant_status_idx" ON "orders" USING btree ("restaurant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_gift_id_idx" ON "payments" USING btree ("gift_id");