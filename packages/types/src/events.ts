import { z } from "zod";
import {
  OrderSchema,
  OrderStatusSchema,
  ServiceRequestStatusSchema,
  ServiceRequestTypeSchema,
} from "./domain";

// ============================================
// Event Envelope (EOS Layer 1.2)
// { event_id, event_name, aggregate_id, timestamp, payload, metadata }
// ============================================

export const EventEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  event_name: z.string(),
  aggregate_id: z.string().uuid(),
  timestamp: z.date(),
  payload: z.record(z.unknown()),
  metadata: z.record(z.unknown()).default({}),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const EventNameSchema = z.enum([
  "OrderCreated",
  "PaymentSucceeded",
  "PaymentFailed",
  "CashOnPickupSelected",
  "OrderPreparationStarted",
  "OrderReadyForPickup",
  "OrderPickedUp",
  "OTPGenerated",
  "SettlementCalculated",
  "PosOrderImported",
  "PosMenuSynced",
  "ReferralClaimed",
  "StampCardRewardUnlocked",
  "EarlyReadyAlert",
  "PersonalizedHomepageViewed",
  "TrendingQueried",
  "GroupOrderCreated",
  "GroupOrderItemAdded",
  "GiftPaid",
  "GiftFulfilled",
  "GiftExpired",
  "GiftRefunded",
  "UserArrivedAtRestaurant",
  "WalletCashbackCredited",
  "StreakBadgeUnlocked",
  "SpiceProfileUpdated",
  "CateringOrderCreated",
  "HeatmapQueried",
  "WearOrderListed",
  "VipTicketCreated",
  "VendorApplicationApproved",
  "VendorApplicationRejected",
  "SessionOpened",
  "BillRequested",
  "ServiceRequestCreated",
  "ServiceRequestAcknowledged",
  "ServiceRequestCompleted",
  "ServiceRequestCancelled",
]);
export type EventName = z.infer<typeof EventNameSchema>;

// ============================================
// Core Event Payloads
// ============================================

export const OrderCreatedEventSchema = z.object({
  order: OrderSchema,
});
export type OrderCreatedEvent = z.infer<typeof OrderCreatedEventSchema>;

export const PaymentSucceededEventSchema = z.object({
  order_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  amount: z.number().nonnegative(),
});
export type PaymentSucceededEvent = z.infer<typeof PaymentSucceededEventSchema>;

export const PaymentFailedEventSchema = z.object({
  order_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  reason: z.string().optional(),
});
export type PaymentFailedEvent = z.infer<typeof PaymentFailedEventSchema>;

export const CashOnPickupSelectedEventSchema = z.object({
  order_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  amount: z.number().nonnegative(),
});
export type CashOnPickupSelectedEvent = z.infer<typeof CashOnPickupSelectedEventSchema>;

export const OrderPreparationStartedEventSchema = z.object({
  order_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
});
export type OrderPreparationStartedEvent = z.infer<typeof OrderPreparationStartedEventSchema>;

export const OrderReadyForPickupEventSchema = z.object({
  order_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
});
export type OrderReadyForPickupEvent = z.infer<typeof OrderReadyForPickupEventSchema>;

export const OrderPickedUpEventSchema = z.object({
  order_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  pickup_otp: z.string().length(6),
});
export type OrderPickedUpEvent = z.infer<typeof OrderPickedUpEventSchema>;

export const OTPGeneratedEventSchema = z.object({
  order_id: z.string().uuid(),
  phone: z.string(),
  expires_at: z.date(),
});
export type OTPGeneratedEvent = z.infer<typeof OTPGeneratedEventSchema>;

export const SettlementCalculatedEventSchema = z.object({
  restaurant_id: z.string().uuid(),
  period_start: z.date(),
  period_end: z.date(),
  total_commission: z.number().nonnegative(),
  total_payout: z.number().nonnegative(),
});
export type SettlementCalculatedEvent = z.infer<typeof SettlementCalculatedEventSchema>;

export const PosOrderImportedEventSchema = z.object({
  order_id: z.string().uuid(),
  pos_order_id: z.string(),
  restaurant_id: z.string().uuid(),
});
export type PosOrderImportedEvent = z.infer<typeof PosOrderImportedEventSchema>;

export const PosMenuSyncedEventSchema = z.object({
  restaurant_id: z.string().uuid(),
  synced_count: z.number().nonnegative(),
});
export type PosMenuSyncedEvent = z.infer<typeof PosMenuSyncedEventSchema>;

// ============================================
// L05 Referral Claimed (loyalty context)
// Emitted after fraud checks pass and both wallets are credited.
// ============================================

export const ReferralClaimedEventSchema = z.object({
  referrer_user_id: z.string().uuid(),
  claimant_user_id: z.string().uuid(),
  referral_code: z.string(),
  bonus_amount: z.number().positive(),
  ip_address: z.string().optional(),
  device_fingerprint: z.string().optional(),
});
export type ReferralClaimedEvent = z.infer<typeof ReferralClaimedEventSchema>;

// ============================================
// L01 Stamp Card Reward Unlocked (loyalty context)
// Emitted when a user-restaurant card hits 10 stamps.
// ============================================

export const StampCardRewardUnlockedEventSchema = z.object({
  user_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  reward_type: z.literal("FREE_ITEM"),
  stamp_count_before: z.number().int().nonnegative(),
  rewards_earned: z.number().int().nonnegative(),
});
export type StampCardRewardUnlockedEvent = z.infer<typeof StampCardRewardUnlockedEventSchema>;

// ============================================
// P13 Early Ready Alert (fulfillment context)
// Emitted when an order becomes READY_FOR_PICKUP before its
// scheduled_pickup_time - the trigger for Push Notification / SMS.
// ============================================

export const EarlyReadyAlertEventSchema = z.object({
  order_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  scheduled_pickup_time: z.string(),
  ready_time: z.string(),
});
export type EarlyReadyAlertEvent = z.infer<typeof EarlyReadyAlertEventSchema>;

// ============================================
// D07 Personalized Homepage Viewed (discovery context)
// Emitted after a personalized-homepage feed is computed.
// ============================================

export const PersonalizedHomepageViewedEventSchema = z.object({
  user_id: z.string().uuid().optional(),
  strategy: z.enum(["rule_based", "ml_weighted"]),
  is_cold_start: z.boolean(),
  result_count: z.number().int().nonnegative(),
});
export type PersonalizedHomepageViewedEvent = z.infer<typeof PersonalizedHomepageViewedEventSchema>;

// ============================================
// D17 Trending Queried (discovery context)
// Emitted when the time-bounded trending feed is computed.
// ============================================

export const TrendingQueriedEventSchema = z.object({
  radius_km: z.number().positive(),
  minutes: z.number().int().positive(),
  result_count: z.number().int().nonnegative(),
});
export type TrendingQueriedEvent = z.infer<typeof TrendingQueriedEventSchema>;

// ============================================
// O02 Group Order Created (ordering context)
// Emitted when a group cart + its DRAFT order are created.
// ============================================

export const GroupOrderCreatedEventSchema = z.object({
  order_id: z.string().uuid(),
  group_cart_token: z.string(),
  created_by: z.string().uuid(),
  restaurant_id: z.string().uuid(),
});
export type GroupOrderCreatedEvent = z.infer<typeof GroupOrderCreatedEventSchema>;

// ============================================
// O02 Group Order Item Added (ordering context)
// Emitted after a contributor's items are appended under the
// per-token lock - the trigger for the live group cart view.
// ============================================

export const GroupOrderItemAddedEventSchema = z.object({
  order_id: z.string().uuid(),
  group_cart_token: z.string(),
  added_by: z.string().uuid(),
  menu_item_id: z.string().uuid(),
  quantity: z.number().int().positive(),
});
export type GroupOrderItemAddedEvent = z.infer<typeof GroupOrderItemAddedEventSchema>;

// ============================================
// Social Gifting events
// ============================================

export const GiftPaidEventSchema = z.object({
  gift_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  amount: z.number().nonnegative(),
});
export type GiftPaidEvent = z.infer<typeof GiftPaidEventSchema>;

export const GiftFulfilledEventSchema = z.object({
  gift_id: z.string().uuid(),
  sender_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  order_id: z.string().uuid(),
});
export type GiftFulfilledEvent = z.infer<typeof GiftFulfilledEventSchema>;

export const GiftExpiredEventSchema = z.object({
  gift_id: z.string().uuid(),
});
export type GiftExpiredEvent = z.infer<typeof GiftExpiredEventSchema>;

export const GiftRefundedEventSchema = z.object({
  gift_id: z.string().uuid(),
  sender_id: z.string().uuid(),
  amount: z.number().nonnegative(),
});
export type GiftRefundedEvent = z.infer<typeof GiftRefundedEventSchema>;

// ============================================
// P02 User Arrived At Restaurant (fulfillment context)
// Emitted when the user's location crosses the 100 m geo-fence while the
// order is READY_FOR_PICKUP - auto check-in (P03) has just happened.
// ============================================

export const UserArrivedAtRestaurantEventSchema = z.object({
  order_id: z.string().uuid(),
  user_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  distance_m: z.number().nonnegative(),
  auto_checked_in: z.boolean(),
});
export type UserArrivedAtRestaurantEvent = z.infer<typeof UserArrivedAtRestaurantEventSchema>;

// ============================================
// O12 Wallet Cashback Credited (loyalty context)
// Emitted after 1% of an order's total is credited to the user's wallet
// on OrderPickedUp. The trigger for balance-change notifications.
// ============================================

export const WalletCashbackCreditedEventSchema = z.object({
  user_id: z.string().uuid(),
  order_id: z.string().uuid(),
  amount: z.number().nonnegative(),
  balance_after: z.number().nonnegative(),
});
export type WalletCashbackCreditedEvent = z.infer<typeof WalletCashbackCreditedEventSchema>;

// ============================================
// L02 Streak Badge Unlocked (loyalty context)
// Emitted when a user's consecutive-day pickup streak hits a multiple of
// 7 - a 10% off coupon is minted alongside the badge.
// ============================================

export const StreakBadgeUnlockedEventSchema = z.object({
  user_id: z.string().uuid(),
  streak: z.number().int().positive(),
  coupon_code: z.string(),
  discount_rate: z.number().positive(),
});
export type StreakBadgeUnlockedEvent = z.infer<typeof StreakBadgeUnlockedEventSchema>;

// ============================================
// D03 Spice Profile Updated (identity context)
// Emitted after a user updates spice_tolerance (1-5). Downstream menu
// fetches filter out items exceeding the new tolerance.
// ============================================

export const SpiceProfileUpdatedEventSchema = z.object({
  user_id: z.string().uuid(),
  spice_tolerance: z.number().int().min(1).max(5),
});
export type SpiceProfileUpdatedEvent = z.infer<typeof SpiceProfileUpdatedEventSchema>;

// ============================================
// W12 Catering Order Created (ordering context)
// Emitted when a bulk B2B catering request (50+ headcount) is placed and
// confirmed by the simulated catering-confirmation flow.
// ============================================

export const CateringOrderCreatedEventSchema = z.object({
  order_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  headcount: z.number().int().positive(),
  event_date: z.string(),
  total_amount: z.number().nonnegative(),
  line_count: z.number().int().positive(),
});
export type CateringOrderCreatedEvent = z.infer<typeof CateringOrderCreatedEventSchema>;

// ============================================
// D04 Heatmap Queried (discovery context)
// Emitted whenever the 30-minute hyperlocal order-density grid is computed.
// ============================================

export const HeatmapQueriedEventSchema = z.object({
  window_minutes: z.number().int().positive(),
  cell_count: z.number().int().nonnegative(),
  total_orders: z.number().int().nonnegative(),
});
export type HeatmapQueriedEvent = z.infer<typeof HeatmapQueriedEventSchema>;

// ============================================
// W14 Wear Order Listed (fulfillment context)
// Emitted after the minimal watch payload for a user's active orders is built.
// ============================================

export const WearOrderListedEventSchema = z.object({
  user_id: z.string().uuid(),
  active_count: z.number().int().nonnegative(),
});
export type WearOrderListedEvent = z.infer<typeof WearOrderListedEventSchema>;

// ============================================
// L15 VIP Ticket Created (support context)
// Emitted when a support ticket is opened; VIP callers are routed to a
// specialized OPS_AGENT with HIGH priority.
// ============================================

export const VipTicketCreatedEventSchema = z.object({
  ticket_id: z.string().uuid(),
  user_id: z.string().uuid(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
  assignee: z.string().nullable(),
  is_vip: z.boolean(),
});
export type VipTicketCreatedEvent = z.infer<typeof VipTicketCreatedEventSchema>;

// ============================================
// Vendor Onboarding Decision (marketplace context)
// Emitted after a vendor application is approved/rejected so downstream
// subscribers (notifications, analytics) can react without blocking the
// admin request path.
// ============================================

export const VendorApplicationApprovedEventSchema = z.object({
  applicant_id: z.string().uuid(),
  name: z.string(),
  phone: z.string(),
  contact_email: z.string().nullable(),
  vendor_id: z.string().uuid(),
});
export type VendorApplicationApprovedEvent = z.infer<typeof VendorApplicationApprovedEventSchema>;

export const VendorApplicationRejectedEventSchema = z.object({
  applicant_id: z.string().uuid(),
  name: z.string(),
  phone: z.string(),
  contact_email: z.string().nullable(),
  reason: z.string().nullable(),
});
export type VendorApplicationRejectedEvent = z.infer<typeof VendorApplicationRejectedEventSchema>;

// ============================================
// Dine-In events (D2.5C9.1)
//
// Emitted from committed Dine-In session mutations. Payloads carry ONLY the
// frozen facts required by consumers: aggregate identity, restaurant/table
// scoping, and the transition-specific values. No table_token, PII, payment
// data, actor profile, full DTO snapshots, UI text, or audit timestamps.
// No domain transition timestamps in payloads (envelope timestamp is
// post-commit observation time, owned by the envelope constructor).
// ============================================

export const SessionOpenedEventSchema = z.object({
  restaurant_id: z.string().uuid(),
  table_id: z.string().uuid(),
  customer_user_id: z.string().uuid(),
});
export type SessionOpenedEvent = z.infer<typeof SessionOpenedEventSchema>;

export const BillRequestedEventSchema = z.object({
  restaurant_id: z.string().uuid(),
  table_id: z.string().uuid(),
  session_bill_id: z.string().uuid(),
  total_amount: z.number().nonnegative(),
});
export type BillRequestedEvent = z.infer<typeof BillRequestedEventSchema>;

export const ServiceRequestCreatedEventSchema = z.object({
  restaurant_id: z.string().uuid(),
  session_id: z.string().uuid(),
  request_type: ServiceRequestTypeSchema,
  request_status: ServiceRequestStatusSchema,
  // Optional note only where the request type actually carries one.
  // BRING_BILL (the only current type) is system-generated without a note.
  note: z.string().nullable().optional(),
});
export type ServiceRequestCreatedEvent = z.infer<typeof ServiceRequestCreatedEventSchema>;

export const ServiceRequestAcknowledgedEventSchema = z.object({
  restaurant_id: z.string().uuid(),
  session_id: z.string().uuid(),
  request_type: ServiceRequestTypeSchema,
  request_status: ServiceRequestStatusSchema,
});
export type ServiceRequestAcknowledgedEvent = z.infer<
  typeof ServiceRequestAcknowledgedEventSchema
>;

export const ServiceRequestCompletedEventSchema = z.object({
  restaurant_id: z.string().uuid(),
  session_id: z.string().uuid(),
  request_type: ServiceRequestTypeSchema,
  request_status: ServiceRequestStatusSchema,
});
export type ServiceRequestCompletedEvent = z.infer<
  typeof ServiceRequestCompletedEventSchema
>;

export const ServiceRequestCancelledEventSchema = z.object({
  restaurant_id: z.string().uuid(),
  session_id: z.string().uuid(),
  request_type: ServiceRequestTypeSchema,
  request_status: ServiceRequestStatusSchema,
});
export type ServiceRequestCancelledEvent = z.infer<
  typeof ServiceRequestCancelledEventSchema
>;

// ============================================
// Event Catalog - typed envelope factory
// ============================================

export type EventPayloadMap = {
  OrderCreated: OrderCreatedEvent;
  PaymentSucceeded: PaymentSucceededEvent;
  PaymentFailed: PaymentFailedEvent;
  CashOnPickupSelected: CashOnPickupSelectedEvent;
  OrderPreparationStarted: OrderPreparationStartedEvent;
  OrderReadyForPickup: OrderReadyForPickupEvent;
  OrderPickedUp: OrderPickedUpEvent;
  OTPGenerated: OTPGeneratedEvent;
  SettlementCalculated: SettlementCalculatedEvent;
  PosOrderImported: PosOrderImportedEvent;
  PosMenuSynced: PosMenuSyncedEvent;
  ReferralClaimed: ReferralClaimedEvent;
  StampCardRewardUnlocked: StampCardRewardUnlockedEvent;
  EarlyReadyAlert: EarlyReadyAlertEvent;
  PersonalizedHomepageViewed: PersonalizedHomepageViewedEvent;
  TrendingQueried: TrendingQueriedEvent;
  GroupOrderCreated: GroupOrderCreatedEvent;
  GroupOrderItemAdded: GroupOrderItemAddedEvent;
  GiftPaid: GiftPaidEvent;
  GiftFulfilled: GiftFulfilledEvent;
  GiftExpired: GiftExpiredEvent;
  GiftRefunded: GiftRefundedEvent;
  UserArrivedAtRestaurant: UserArrivedAtRestaurantEvent;
  WalletCashbackCredited: WalletCashbackCreditedEvent;
  StreakBadgeUnlocked: StreakBadgeUnlockedEvent;
  SpiceProfileUpdated: SpiceProfileUpdatedEvent;
  CateringOrderCreated: CateringOrderCreatedEvent;
  HeatmapQueried: HeatmapQueriedEvent;
  WearOrderListed: WearOrderListedEvent;
  VipTicketCreated: VipTicketCreatedEvent;
  VendorApplicationApproved: VendorApplicationApprovedEvent;
  VendorApplicationRejected: VendorApplicationRejectedEvent;
  SessionOpened: SessionOpenedEvent;
  BillRequested: BillRequestedEvent;
  ServiceRequestCreated: ServiceRequestCreatedEvent;
  ServiceRequestAcknowledged: ServiceRequestAcknowledgedEvent;
  ServiceRequestCompleted: ServiceRequestCompletedEvent;
  ServiceRequestCancelled: ServiceRequestCancelledEvent;
};

export type TypedEventEnvelope<K extends EventName = EventName> = Omit<
  EventEnvelope,
  "event_name" | "payload"
> & {
  event_name: K;
  payload: EventPayloadMap[K];
};

export function createEvent<K extends EventName>(
  event_name: K,
  aggregate_id: string,
  payload: EventPayloadMap[K],
  metadata: Record<string, unknown> = {},
  event_id = crypto.randomUUID(),
  timestamp = new Date(),
): TypedEventEnvelope<K> {
  return { event_id, event_name, aggregate_id, timestamp, payload, metadata };
}

export { OrderStatusSchema };
