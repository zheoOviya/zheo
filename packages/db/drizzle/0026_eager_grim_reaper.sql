CREATE TYPE "public"."event_outbox_status" AS ENUM('PENDING', 'CLAIMED', 'DEAD');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"status" "event_outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_outbox_event_id_uq" ON "event_outbox" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_outbox_status_next_idx" ON "event_outbox" USING btree ("status","next_attempt_at");