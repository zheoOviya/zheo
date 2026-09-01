import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  decimal,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { menu_items, restaurants } from "./catalog";
import { users } from "./identity";

// ============================================
// Dine-In / Smart Table Ordering bounded context.
// Physical schema contract per frozen D2.1 + D2.1-R1.
//
// Canonical parent coherence keys are UNIQUE(restaurant_id, id); every child
// references back in the same order: (restaurant_id, parent_id) ->
// parent(restaurant_id, id). This makes same-outlet relationships referential
// facts rather than service-layer habits.
// ============================================

export const diningSessionStatusEnum = pgEnum("dining_session_status", [
  "OPEN",
  "ACTIVE",
  "BILL_REQUESTED",
  "PAYMENT_PENDING",
  "CLOSED",
]);

export const dineInOrderStatusEnum = pgEnum("dine_in_order_status", [
  "PLACED",
  "PREPARING",
  "READY_TO_SERVE",
  "SERVED",
  "CANCELLED",
]);

export const staffAssignmentStatusEnum = pgEnum("staff_assignment_status", [
  "ACTIVE",
  "ENDED",
]);

export const serviceRequestTypeEnum = pgEnum("service_request_type", [
  "WATER",
  "EXTRA_PLATE",
  "CUTLERY",
  "TISSUE",
  "CLEAN_TABLE",
  "CALL_STAFF",
  "BRING_BILL",
  "OTHER",
]);

export const serviceRequestStatusEnum = pgEnum("service_request_status", [
  "PENDING",
  "ACKNOWLEDGED",
  "COMPLETED",
  "CANCELLED",
]);

export const dine_zones = pgTable(
  "dine_zones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    is_active: boolean("is_active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    restaurantIdx: index("dine_zones_restaurant_idx").on(table.restaurant_id),
    restaurantNameUnique: uniqueIndex("dine_zones_restaurant_name_idx").on(
      table.restaurant_id,
      table.name,
    ),
    restaurantIdUnique: uniqueIndex("dine_zones_restaurant_id_idx").on(
      table.restaurant_id,
      table.id,
    ),
    nameNotEmpty: check("dine_zones_name_not_empty", sql`${table.name} <> ''`),
  }),
);

export const restaurant_tables = pgTable(
  "restaurant_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    // Zone membership is optional; the composite FK below guarantees a
    // non-null zone always belongs to the same restaurant. MATCH SIMPLE
    // semantics mean NULL zone_id simply bypasses the constraint.
    zone_id: uuid("zone_id"),
    label: text("label").notNull(),
    // Opaque high-entropy token encoded by the table QR. Never a raw id.
    table_token: text("table_token").notNull(),
    seat_count: integer("seat_count"),
    is_active: boolean("is_active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    restaurantIdx: index("restaurant_tables_restaurant_idx").on(table.restaurant_id),
    zoneIdx: index("restaurant_tables_zone_idx").on(table.zone_id),
    restaurantLabelUnique: uniqueIndex("restaurant_tables_restaurant_label_idx").on(
      table.restaurant_id,
      table.label,
    ),
    tableTokenUnique: uniqueIndex("restaurant_tables_table_token_idx").on(
      table.table_token,
    ),
    // Parent coherence key (canonical order) for dining_sessions.
    restaurantIdUnique: uniqueIndex("restaurant_tables_restaurant_id_idx").on(
      table.restaurant_id,
      table.id,
    ),
    zoneCoherenceFk: foreignKey({
      columns: [table.restaurant_id, table.zone_id],
      foreignColumns: [dine_zones.restaurant_id, dine_zones.id],
    }).onDelete("restrict"),
    labelNotEmpty: check("restaurant_tables_label_not_empty", sql`${table.label} <> ''`),
    tokenLength: check(
      "restaurant_tables_token_length",
      sql`length(${table.table_token}) >= 32`,
    ),
    seatCountPositive: check(
      "restaurant_tables_seat_count_positive",
      sql`${table.seat_count} IS NULL OR ${table.seat_count} > 0`,
    ),
  }),
);

export const dining_sessions = pgTable(
  "dining_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    table_id: uuid("table_id")
      .notNull()
      .references(() => restaurant_tables.id),
    owner_user_id: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    status: diningSessionStatusEnum("status").notNull().default("OPEN"),
    bill_requested_at: timestamp("bill_requested_at", { withTimezone: true }),
    payment_pending_at: timestamp("payment_pending_at", { withTimezone: true }),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tableIdx: index("dining_sessions_table_idx").on(table.table_id),
    restaurantStatusIdx: index("dining_sessions_restaurant_status_idx").on(
      table.restaurant_id,
      table.status,
    ),
    ownerIdx: index("dining_sessions_owner_idx").on(table.owner_user_id),
    createdAtIdx: index("dining_sessions_created_idx").on(table.created_at),
    // ≤1 live session per table. Occupancy is DERIVED from this invariant.
    liveSessionUnique: uniqueIndex("dining_sessions_live_table_idx")
      .on(table.table_id)
      .where(
        sql`${table.status} IN ('OPEN', 'ACTIVE', 'BILL_REQUESTED', 'PAYMENT_PENDING')`,
      ),
    // Parent coherence key (canonical order) for all session children.
    restaurantIdUnique: uniqueIndex("dining_sessions_restaurant_id_idx").on(
      table.restaurant_id,
      table.id,
    ),
    tableCoherenceFk: foreignKey({
      columns: [table.restaurant_id, table.table_id],
      foreignColumns: [restaurant_tables.restaurant_id, restaurant_tables.id],
    }),
    timeOrderCheck: check(
      "dining_sessions_time_order",
      sql`${table.created_at} <= ${table.updated_at}`,
    ),
  }),
);

export const staff_assignments = pgTable(
  "staff_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    session_id: uuid("session_id")
      .notNull()
      .references(() => dining_sessions.id),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    staff_user_id: uuid("staff_user_id")
      .notNull()
      .references(() => users.id),
    assigned_by: uuid("assigned_by").references(() => users.id),
    // NULL when auto-assigned by zone, else the zone that produced it. Must
    // belong to the same restaurant (composite FK below).
    zone_id: uuid("zone_id"),
    status: staffAssignmentStatusEnum("status").notNull().default("ACTIVE"),
    assigned_at: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ended_at: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => ({
    staffActiveIdx: index("staff_assignments_staff_active_idx").on(
      table.staff_user_id,
      table.status,
    ),
    sessionIdx: index("staff_assignments_session_idx").on(table.session_id),
    restaurantStatusIdx: index("staff_assignments_restaurant_status_idx").on(
      table.restaurant_id,
      table.status,
    ),
    // ≤1 ACTIVE assignment per session. Reassignment = end + create.
    activeAssignmentUnique: uniqueIndex("staff_assignments_active_session_idx")
      .on(table.session_id)
      .where(sql`${table.status} = 'ACTIVE'`),
    sessionCoherenceFk: foreignKey({
      columns: [table.restaurant_id, table.session_id],
      foreignColumns: [dining_sessions.restaurant_id, dining_sessions.id],
    }),
    zoneCoherenceFk: foreignKey({
      columns: [table.restaurant_id, table.zone_id],
      foreignColumns: [dine_zones.restaurant_id, dine_zones.id],
    }).onDelete("restrict"),
    timeOrderCheck: check(
      "staff_assignments_time_order",
      sql`${table.ended_at} IS NULL OR ${table.ended_at} >= ${table.assigned_at}`,
    ),
  }),
);

export const dine_in_orders = pgTable(
  "dine_in_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    session_id: uuid("session_id")
      .notNull()
      .references(() => dining_sessions.id),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    placed_by: uuid("placed_by")
      .notNull()
      .references(() => users.id),
    status: dineInOrderStatusEnum("status").notNull().default("PLACED"),
    total_amount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
    notes: text("notes"),
    served_at: timestamp("served_at", { withTimezone: true }),
    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    cancelled_by: uuid("cancelled_by").references(() => users.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sessionIdx: index("dine_in_orders_session_idx").on(table.session_id),
    restaurantStatusIdx: index("dine_in_orders_restaurant_status_idx").on(
      table.restaurant_id,
      table.status,
    ),
    createdAtIdx: index("dine_in_orders_created_idx").on(table.created_at),
    // Parent coherence key (canonical order) for dine_in_order_items.
    restaurantIdUnique: uniqueIndex("dine_in_orders_restaurant_id_idx").on(
      table.restaurant_id,
      table.id,
    ),
    sessionCoherenceFk: foreignKey({
      columns: [table.restaurant_id, table.session_id],
      foreignColumns: [dining_sessions.restaurant_id, dining_sessions.id],
    }),
    totalNonNegative: check(
      "dine_in_orders_total_non_negative",
      sql`${table.total_amount} >= 0`,
    ),
  }),
);

export const dine_in_order_items = pgTable(
  "dine_in_order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dine_in_order_id: uuid("dine_in_order_id")
      .notNull()
      .references(() => dine_in_orders.id),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    menu_item_id: uuid("menu_item_id")
      .notNull()
      .references(() => menu_items.id),
    // Historical snapshot: preserves name/pricing after menu edits.
    name: text("name").notNull(),
    base_price: decimal("base_price", { precision: 10, scale: 2 }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    customizations: jsonb("customizations")
      .$type<Array<{ name: string; price_delta: number }>>()
      .notNull()
      .default([]),
    customization_total: decimal("customization_total", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("0.00"),
    item_subtotal: decimal("item_subtotal", { precision: 10, scale: 2 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderIdx: index("dine_in_order_items_order_idx").on(table.dine_in_order_id),
    menuItemIdx: index("dine_in_order_items_menu_item_idx").on(table.menu_item_id),
    orderCoherenceFk: foreignKey({
      columns: [table.restaurant_id, table.dine_in_order_id],
      foreignColumns: [dine_in_orders.restaurant_id, dine_in_orders.id],
    }),
    quantityPositive: check(
      "dine_in_order_items_quantity_positive",
      sql`${table.quantity} > 0`,
    ),
    subtotalNonNegative: check(
      "dine_in_order_items_subtotal_non_negative",
      sql`${table.item_subtotal} >= 0`,
    ),
    customTotalNonNegative: check(
      "dine_in_order_items_custom_total_non_negative",
      sql`${table.customization_total} >= 0`,
    ),
  }),
);

export const service_requests = pgTable(
  "service_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    session_id: uuid("session_id")
      .notNull()
      .references(() => dining_sessions.id),
    // Denormalized for routing/indexing only. Table identity is DERIVED via
    // dining_sessions.table_id — there is deliberately no table_id column.
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    requested_by: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    request_type: serviceRequestTypeEnum("request_type").notNull(),
    status: serviceRequestStatusEnum("status").notNull().default("PENDING"),
    note: text("note"),
    acknowledged_by: uuid("acknowledged_by").references(() => users.id),
    acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
    completed_by: uuid("completed_by").references(() => users.id),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sessionIdx: index("service_requests_session_idx").on(table.session_id),
    restaurantStatusIdx: index("service_requests_restaurant_status_idx").on(
      table.restaurant_id,
      table.status,
    ),
    requestedByIdx: index("service_requests_requested_by_idx").on(table.requested_by),
    sessionCoherenceFk: foreignKey({
      columns: [table.restaurant_id, table.session_id],
      foreignColumns: [dining_sessions.restaurant_id, dining_sessions.id],
    }),
    ackConsistency: check(
      "service_requests_ack_consistency",
      sql`(${table.acknowledged_by} IS NULL) = (${table.acknowledged_at} IS NULL)`,
    ),
    completeConsistency: check(
      "service_requests_complete_consistency",
      sql`(${table.completed_by} IS NULL) = (${table.completed_at} IS NULL)`,
    ),
    noteRequiredForOther: check(
      "service_requests_note_for_other",
      sql`${table.request_type} <> 'OTHER' OR ${table.note} IS NOT NULL`,
    ),
  }),
);

export const session_bills = pgTable(
  "session_bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    session_id: uuid("session_id")
      .notNull()
      .references(() => dining_sessions.id),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    food_subtotal: decimal("food_subtotal", { precision: 10, scale: 2 }).notNull(),
    // Dine-in pricing override: packaging is excluded (₹0), per D1.
    packaging_fee: decimal("packaging_fee", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    gst_food: decimal("gst_food", { precision: 10, scale: 2 }).notNull(),
    gst_packaging: decimal("gst_packaging", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    total_amount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
    frozen_at: timestamp("frozen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Deliberately no updated_at: a frozen bill is immutable (domain rule).
    // Immutability is enforced at the repository/service layer (insert-only);
    // a DB trigger guard is deferred out of schema scope.
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Exactly one bill per session.
    sessionUnique: uniqueIndex("session_bills_session_idx").on(table.session_id),
    sessionCoherenceFk: foreignKey({
      columns: [table.restaurant_id, table.session_id],
      foreignColumns: [dining_sessions.restaurant_id, dining_sessions.id],
    }),
    arithmeticCheck: check(
      "session_bills_arithmetic",
      sql`${table.total_amount} = ${table.food_subtotal} + ${table.packaging_fee} + ${table.gst_food} + ${table.gst_packaging}`,
    ),
    nonNegativeCheck: check(
      "session_bills_non_negative",
      sql`${table.food_subtotal} >= 0 AND ${table.packaging_fee} >= 0 AND ${table.gst_food} >= 0 AND ${table.gst_packaging} >= 0 AND ${table.total_amount} >= 0`,
    ),
  }),
);
