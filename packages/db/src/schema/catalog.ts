import { sql } from "drizzle-orm";
import {
  boolean,
  decimal,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { chains } from "./chain";

export const restaurants = pgTable(
  "restaurants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    // V15 (Phase 4): nullable FK to the owning chain. Independent outlets
    // simply have no chain_id.
    chain_id: uuid("chain_id").references(() => chains.id),
    name: text("name").notNull(),
    gst_number: text("gst_number").notNull(),
    fssai_license: text("fssai_license").notNull(),
    commission_rate: decimal("commission_rate", { precision: 5, scale: 2 })
      .notNull()
      .default("0.08"),
    is_active: boolean("is_active").notNull().default(true),
    // P04 traffic ETA: restaurant pickup location.
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    ownerIdx: index("restaurants_owner_idx").on(table.owner_id),
    nameIdx: index("restaurants_name_idx").on(table.name),
    // V15 (Phase 4): multi-outlet dashboard groups restaurants by chain_id.
    chainIdx: index("restaurants_chain_idx").on(table.chain_id),
  }),
);

export const menu_items = pgTable(
  "menu_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    price: decimal("price", { precision: 10, scale: 2 }).notNull(),
    description: text("description"),
    dietary_tags: jsonb("dietary_tags")
      .$type<Record<string, boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    customizations: jsonb("customizations")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    image_url: text("image_url"),
    pos_item_id: text("pos_item_id"),
    is_available: boolean("is_available").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    restaurantIdx: index("menu_items_restaurant_idx").on(table.restaurant_id),
    nameIdx: index("menu_items_name_idx").on(table.name),
    // V01 POS sync looks up menu items by (restaurant_id, pos_item_id).
    posItemIdx: index("menu_items_pos_item_idx").on(
      table.restaurant_id,
      table.pos_item_id,
    ),
    // CRITICAL: GIN index on JSONB dietary_tags for @> containment queries.
    // Enables efficient lookups like: WHERE dietary_tags @> '{"vegan": true}'
    dietaryTagsGinIdx: index("menu_items_dietary_tags_gin_idx")
      .using("gin", sql`${table.dietary_tags} jsonb_path_ops`),
  }),
);
