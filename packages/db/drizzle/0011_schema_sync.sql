ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_suspended" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_reason" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_confirmed_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" TYPE text;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'CONSUMER';
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
DO $$ BEGIN
 CREATE TYPE "public"."support_ticket_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."support_ticket_status" AS ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
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
CREATE INDEX IF NOT EXISTS "support_tickets_user_idx" ON "support_tickets" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_priority_idx" ON "support_tickets" USING btree ("priority");
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENT', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
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
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_status_next_idx" ON "notifications" USING btree ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_idx" ON "notifications" USING btree ("user_id");
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."user_role_scope" AS ENUM('platform', 'chain', 'restaurant');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
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
DO $$ BEGIN
 ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_scope_idx" ON "user_roles" USING btree ("scope_type", "scope_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_user_idx" ON "user_roles" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_roles_membership_idx" ON "user_roles" USING btree ("user_id", "scope_type", "scope_id");
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "pickup_eta_min" integer DEFAULT 20 NOT NULL;
