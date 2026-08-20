import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { menu_items, restaurants } from "./catalog";
import { users } from "./identity";

// PRD Section 4: Order State Machine - 13 SQL states
export const orderStatusEnum = pgEnum("order_status", [
  "DRAFT",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
  "PICKED_UP",
  "CANCELLED",
  "REFUNDED",
  "PAYMENT_FAILED",
  "EXPIRED",
  "DISPUTED",
  "SETTLED",
]);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    total_amount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
    status: orderStatusEnum("status").notNull().default("DRAFT"),
    // W12 (Phase 4): bulk B2B catering order flags. Standard orders default
    // is_catering=false and headcount=NULL.
    is_catering: boolean("is_catering").notNull().default(false),
    headcount: integer("headcount"),
    pickup_otp: text("pickup_otp"),
    scheduled_pickup_time: timestamp("scheduled_pickup_time", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("orders_user_idx").on(table.user_id),
    restaurantIdx: index("orders_restaurant_idx").on(table.restaurant_id),
    statusIdx: index("orders_status_idx").on(table.status),
    createdAtIdx: index("orders_created_at_idx").on(table.created_at),
    // V15 (Phase 4): chain dashboard scans orders by (restaurant, status).
    restaurantStatusIdx: index("orders_restaurant_status_idx").on(
      table.restaurant_id,
      table.status,
    ),
  }),
);

export const order_items = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    order_id: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    menu_item_id: uuid("menu_item_id")
      .notNull()
      .references(() => menu_items.id),
    name: text("name").notNull(),
    base_price: decimal("base_price", { precision: 10, scale: 2 }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    customizations: jsonb("customizations")
      .$type<Array<{ name: string; price_delta: number }>>()
      .notNull()
      .default([]),
    customization_total: decimal("customization_total", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    item_subtotal: decimal("item_subtotal", { precision: 10, scale: 2 })
      .notNull(),
    // Redeemed gift id; a paid gift line is recorded at ₹0.
    gift_id: uuid("gift_id"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderIdx: index("order_items_order_idx").on(table.order_id),
    menuItemIdx: index("order_items_menu_item_idx").on(table.menu_item_id),
  }),
);
