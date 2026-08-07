import { z } from "zod";

// ============================================
// Bounded Context: identity
// ============================================

export const UserRoleSchema = z.enum([
  "CONSUMER",
  "VENDOR_OWNER",
  "VENDOR_STAFF",
  "OPS_AGENT",
  "ADMIN",
  "SUPER_ADMIN",
]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  phone: z.string().regex(/^\+?[0-9]{10,15}$/, "Invalid phone number"),
  spice_tolerance: z.number().int().min(0).max(5).default(3),
  role: UserRoleSchema.default("CONSUMER"),
  created_at: z.date(),
});
export type User = z.infer<typeof UserSchema>;

export const AuditLogSchema = z.object({
  id: z.string().uuid(),
  actor_id: z.string().uuid(),
  action: z.string(),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.date(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

// ============================================
// Bounded Context: catalog
// ============================================

export const RestaurantSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  name: z.string().min(1),
  gst_number: z.string().min(1),
  fssai_license: z.string().min(1),
  commission_rate: z.coerce.number().default(0.08),
  is_active: z.boolean().default(true),
  created_at: z.date(),
});
export type Restaurant = z.infer<typeof RestaurantSchema>;

export const DietaryTagsSchema = z.record(z.boolean());
export type DietaryTags = z.infer<typeof DietaryTagsSchema>;

export const MenuItemSchema = z.object({
  id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  name: z.string().min(1),
  price: z.coerce.number().nonnegative(),
  dietary_tags: DietaryTagsSchema.default({}),
  customizations: z.array(z.unknown()).default([]),
  is_available: z.boolean().default(true),
  created_at: z.date(),
});
export type MenuItem = z.infer<typeof MenuItemSchema>;

// ============================================
// Bounded Context: ordering
// ============================================

export const OrderStatusSchema = z.enum([
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
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  total_amount: z.coerce.number().nonnegative(),
  status: OrderStatusSchema.default("DRAFT"),
  // W12 (Phase 4): bulk B2B catering order flags.
  is_catering: z.boolean().default(false),
  headcount: z.number().int().nullable().default(null),
  pickup_otp: z.string().length(6).nullable().default(null),
  created_at: z.date(),
  updated_at: z.date(),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderItemSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  menu_item_id: z.string().uuid(),
  name: z.string().min(1),
  base_price: z.coerce.number().nonnegative(),
  quantity: z.number().int().positive().default(1),
  customizations: z
    .array(z.object({ name: z.string(), price_delta: z.number() }))
    .default([]),
  customization_total: z.coerce.number().default(0),
  item_subtotal: z.coerce.number().nonnegative(),
  created_at: z.date(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

// ============================================
// Bounded Context: payments
// ============================================

export const PaymentStatusSchema = z.enum([
  "CREATED",
  "AUTHORIZED",
  "CAPTURED",
  "FAILED",
  "REFUNDED",
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PaymentSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  provider: z.string().default("razorpay"),
  provider_transaction_id: z.string().min(1),
  amount: z.coerce.number().nonnegative(),
  status: PaymentStatusSchema.default("CREATED"),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.date(),
});
export type Payment = z.infer<typeof PaymentSchema>;

// ============================================
// Bounded Context: fulfillment
// ============================================

export const OrderStatusHistorySchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  from_status: OrderStatusSchema.nullable(),
  to_status: OrderStatusSchema,
  transitioned_at: z.date(),
  note: z.string().nullable(),
});
export type OrderStatusHistory = z.infer<typeof OrderStatusHistorySchema>;
