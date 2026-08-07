ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "scheduled_pickup_time" timestamptz;
