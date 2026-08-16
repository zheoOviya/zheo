import {
  decimal,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";

// ============================================
// Vendor onboarding applications (marketplace)
// A restaurant owner applies to onboard as a vendor. Admins review the
// application and either approve it (creating an active restaurant and
// upgrading the applicant to VENDOR_OWNER) or reject it with a reason.
// `type` distinguishes a single restaurant from a chain: CHAIN approval
// creates a chains row plus `outlet_count` restaurant rows.
// ============================================

export const vendorApplicationStatusEnum = pgEnum("vendor_application_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export const vendorApplicationTypeEnum = pgEnum("vendor_application_type", [
  "SINGLE",
  "CHAIN",
]);

export const vendor_applications = pgTable(
  "vendor_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicant_id: uuid("applicant_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    gst_number: text("gst_number").notNull(),
    fssai_license: text("fssai_license").notNull(),
    phone: text("phone").notNull(),
    contact_email: text("contact_email"),
    address: text("address"),
    city: text("city"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    commission_rate: decimal("commission_rate", { precision: 5, scale: 2 })
      .notNull()
      .default("0.08"),
    status: vendorApplicationStatusEnum("status").notNull().default("PENDING"),
    type: vendorApplicationTypeEnum("type").notNull().default("SINGLE"),
    outlet_count: integer("outlet_count").notNull().default(1),
    rejection_reason: text("rejection_reason"),
    reviewer_id: uuid("reviewer_id").references(() => users.id),
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    applicantIdx: index("vendor_applications_applicant_idx").on(table.applicant_id),
    statusIdx: index("vendor_applications_status_idx").on(table.status),
  }),
);
