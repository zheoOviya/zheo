ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "rating" double precision;
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "cuisines" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "price_for_one" integer;
--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "cover_image" text;
