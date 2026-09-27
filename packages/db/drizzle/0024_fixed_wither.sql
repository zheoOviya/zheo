ALTER TABLE "payments" ADD COLUMN "gateway_status" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reconciliation_status" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reconciliation_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "manual_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;