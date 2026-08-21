import {
  decimal,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { menu_items, restaurants } from "./catalog";
import { users } from "./identity";

export const giftStatusEnum = pgEnum("gift_status", [
  "PENDING",
  "ACTIVE",
  "CLAIMED",
  "FULFILLED",
  "EXPIRED",
  "REFUNDING",
  "REFUNDED",
  "CANCELLED",
]);

/** Frozen copy of the sender's chosen configuration. */
export interface GiftItemSnapshot {
  name: string;
  price: number;
  image_url: string | null;
  dietary_tags: Record<string, boolean>;
  spice_level: number;
  customizations: { name: string; price_delta: number }[];
}

export const gifts = pgTable(
  "gifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sender_id: uuid("sender_id")
      .notNull()
      .references(() => users.id),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    menu_item_id: uuid("menu_item_id")
      .notNull()
      .references(() => menu_items.id),
    item_snapshot: jsonb("item_snapshot").$type<GiftItemSnapshot>().notNull(),
    price_paid: decimal("price_paid", { precision: 10, scale: 2 }).notNull(),
    message: text("message"),
    recipient_name: text("recipient_name"),
    claim_token: text("claim_token").notNull().unique(),
    claim_code: text("claim_code").notNull(),
    status: giftStatusEnum("status").notNull().default("PENDING"),
    // Legacy, unpopulated link to a payment row. Kept as a bare column: the
    // reverse direction (payments.gift_id -> gifts.id) is the enforced FK.
    payment_id: uuid("payment_id"),
    claimed_by: uuid("claimed_by").references(() => users.id),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    fulfilled_at: timestamp("fulfilled_at", { withTimezone: true }),
    refunded_at: timestamp("refunded_at", { withTimezone: true }),
    /**
     * Order that redeemed this gift (single-use: a gift binds to at most one
     * order). Deliberately has NO DB FK to orders: the app-layer CAS
     * (bindToOrder/markFulfilled only match redeemed_order_id === orderId)
     * plus the enforced order_items.gift_id -> gifts.id FK guarantee
     * single-use, and a FK here would require a schema import cycle.
     */
    redeemed_order_id: uuid("redeemed_order_id"),
    /** Set once a Razorpay refund has been successfully submitted; guards the expiry sweep against double refunds. */
    refund_requested_at: timestamp("refund_requested_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    senderIdx: index("gifts_sender_idx").on(table.sender_id),
    restaurantIdx: index("gifts_restaurant_idx").on(table.restaurant_id),
    statusIdx: index("gifts_status_idx").on(table.status),
  }),
);
