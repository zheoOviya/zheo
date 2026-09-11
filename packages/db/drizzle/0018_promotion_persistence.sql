CREATE TABLE IF NOT EXISTS "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"discount_type" text NOT NULL,
	"value" numeric NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
