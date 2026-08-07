ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "pos_item_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_items_pos_item_idx" ON "menu_items" USING btree ("restaurant_id", "pos_item_id");
