ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "image_url" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_items_restaurant_idx" ON "menu_items" USING btree ("restaurant_id");
