ALTER TABLE "orders" ADD COLUMN "commission_rate" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "commission_amount" numeric(10, 2);