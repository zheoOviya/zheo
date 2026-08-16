DO $$ BEGIN
 CREATE TYPE "public"."vendor_application_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."vendor_application_type" AS ENUM('SINGLE', 'CHAIN');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
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
ALTER TABLE "vendor_applications" ADD COLUMN IF NOT EXISTS "type" "vendor_application_type" DEFAULT 'SINGLE' NOT NULL;
--> statement-breakpoint
ALTER TABLE "vendor_applications" ADD COLUMN IF NOT EXISTS "outlet_count" integer DEFAULT 1 NOT NULL;
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
CREATE INDEX IF NOT EXISTS "vendor_applications_applicant_idx" ON "vendor_applications" USING btree ("applicant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_applications_status_idx" ON "vendor_applications" USING btree ("status");
