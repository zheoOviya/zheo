import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orderStatusEnum, userRoleEnum } from "../index";

function readAllMigrations(): string {
  const dir = join(__dirname, "..", "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

const sql = readAllMigrations();

describe("Migration SQL (source of truth)", () => {
  it("defines the 13-state order_status enum", () => {
    expect(sql).toMatch(/CREATE TYPE "public"\."order_status"/);
    expect(sql).toMatch(/DRAFT/);
    expect(sql).toMatch(/PAYMENT_PENDING/);
    expect(sql).toMatch(/READY_FOR_PICKUP/);
    expect(sql).toMatch(/PICKED_UP/);
    expect(sql).toMatch(/SETTLED/);
  });

  it("defines the 6-role user_role enum", () => {
    expect(sql).toMatch(/CREATE TYPE "public"\."user_role"/);
    expect(sql).toMatch(/CONSUMER/);
    expect(sql).toMatch(/SUPER_ADMIN/);
  });

  it("defines a GIN index on menu_items.dietary_tags", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "menu_items_dietary_tags_gin_idx" ON "menu_items" USING gin \("dietary_tags" jsonb_path_ops\)/,
    );
  });

  it("defines FK constraints for menu_items.restaurant_id", () => {
    expect(sql).toMatch(/menu_items_restaurant_id_restaurants_id_fk/);
  });

  it("defines FK constraints for orders.user_id and orders.restaurant_id", () => {
    expect(sql).toMatch(/orders_user_id_users_id_fk/);
    expect(sql).toMatch(/orders_restaurant_id_restaurants_id_fk/);
  });

  it("defines order_items table with FK to orders and menu_items", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "order_items"/);
    expect(sql).toMatch(/order_items_order_id_orders_id_fk/);
    expect(sql).toMatch(/order_items_menu_item_id_menu_items_id_fk/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "order_items_order_idx"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "order_items_menu_item_idx"/);
  });

  it("indexes orders by user_id and restaurant_id", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "orders_user_idx"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "orders_restaurant_idx"/);
  });

  it("defines the chains table with owner FK (V15 multi-outlet)", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "chains"/);
    expect(sql).toMatch(/chains_owner_id_users_id_fk/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "chains_owner_idx"/);
  });

  it("adds nullable chain_id to restaurants with FK and index", () => {
    expect(sql).toMatch(
      /ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "chain_id" uuid/,
    );
    expect(sql).toMatch(/restaurants_chain_id_chains_id_fk/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "restaurants_chain_idx"/);
  });

  it("adds W12 catering flags to orders", () => {
    expect(sql).toMatch(
      /ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "is_catering" boolean DEFAULT false NOT NULL/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "headcount" integer/,
    );
  });
});

describe("Exported enums", () => {
  it("order_status has exactly 13 states", () => {
    expect(orderStatusEnum.enumValues).toHaveLength(13);
    expect(orderStatusEnum.enumValues).toContain("READY_FOR_PICKUP");
    expect(orderStatusEnum.enumValues).toContain("SETTLED");
  });

  it("user_role has exactly 7 roles", () => {
    expect(userRoleEnum.enumValues).toHaveLength(7);
    expect(userRoleEnum.enumValues).toContain("PENDING_VENDOR");
    expect(userRoleEnum.enumValues).toContain("SUPER_ADMIN");
  });
});
