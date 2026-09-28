ALTER TABLE "payments" ADD COLUMN "refund_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refund_provider_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refund_initiation_status" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refund_initiation_reason" text;