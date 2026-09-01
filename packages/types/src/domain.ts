import { z } from "zod";

// ============================================
// Bounded Context: identity
// ============================================

export const UserRoleSchema = z.enum([
  "CONSUMER",
  "PENDING_VENDOR",
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

// Public restaurant shape returned by the catalog API and consumed by the
// consumer app. Single source of truth shared by the API route response
// schema and the consumer's `Restaurant` type.
export const RestaurantSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  commission_rate: z.number(),
  is_active: z.boolean(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  pickup_eta_min: z.number().int().min(1).max(120),
  rating: z.number().nonnegative().nullable(),
  cuisines: z.array(z.string()),
  price_for_one: z.number().int().positive().nullable(),
  cover_image: z.string().nullable(),
});
export type Restaurant = z.infer<typeof RestaurantSchema>;

export const DietaryTagsSchema = z.record(z.boolean());
export type DietaryTags = z.infer<typeof DietaryTagsSchema>;

// Public menu-item shape (D03 spice level included; internal fields such as
// description/pos_item_id stay in the repository DTO).
export const MenuItemSchema = z.object({
  id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  name: z.string().min(1),
  price: z.number(),
  dietary_tags: DietaryTagsSchema,
  customizations: z.array(z.unknown()),
  is_available: z.boolean(),
  spice_level: z.number().int().min(1).max(5),
  image_url: z.string().nullable(),
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

// ============================================
// Bounded Context: dine-in
// ============================================

export const DiningSessionStatusSchema = z.enum([
  "OPEN",
  "ACTIVE",
  "BILL_REQUESTED",
  "PAYMENT_PENDING",
  "CLOSED",
]);
export type DiningSessionStatus = z.infer<typeof DiningSessionStatusSchema>;

export const DineInOrderStatusSchema = z.enum([
  "PLACED",
  "PREPARING",
  "READY_TO_SERVE",
  "SERVED",
  "CANCELLED",
]);
export type DineInOrderStatus = z.infer<typeof DineInOrderStatusSchema>;

export const StaffAssignmentStatusSchema = z.enum([
  "ACTIVE",
  "ENDED",
]);
export type StaffAssignmentStatus = z.infer<typeof StaffAssignmentStatusSchema>;

export const ServiceRequestTypeSchema = z.enum([
  "WATER",
  "EXTRA_PLATE",
  "CUTLERY",
  "TISSUE",
  "CLEAN_TABLE",
  "CALL_STAFF",
  "BRING_BILL",
  "OTHER",
]);
export type ServiceRequestType = z.infer<typeof ServiceRequestTypeSchema>;

export const ServiceRequestStatusSchema = z.enum([
  "PENDING",
  "ACKNOWLEDGED",
  "COMPLETED",
  "CANCELLED",
]);
export type ServiceRequestStatus = z.infer<typeof ServiceRequestStatusSchema>;
