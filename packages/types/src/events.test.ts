import { describe, expect, it } from "vitest";
import { createEvent, EventEnvelopeSchema, EventNameSchema, OrderPickedUpEventSchema, TypedEventEnvelope, UserLocationObservedAtRestaurantEventSchema } from "./events";

describe("Event Envelope (EOS Layer 1.2)", () => {
  it("has the exact envelope contract", () => {
    expect(
      EventEnvelopeSchema.safeParse({
        event_id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        event_name: "OrderCreated",
        aggregate_id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        timestamp: new Date(),
        payload: {},
        metadata: {},
      }).success,
    ).toBe(true);
  });

  it("EventNameSchema contains all 33 core events plus the 6 Dine-In events", () => {
    expect(EventNameSchema.options).toEqual([
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
      "UserLocationObservedAtRestaurant",
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
  });

  it("createEvent factory produces a valid typed envelope", () => {
    const orderId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const evt = createEvent(
      "OrderCreated",
      orderId,
      {
        order: {
          id: orderId,
          user_id: orderId,
          restaurant_id: orderId,
          total_amount: 245,
          status: "CONFIRMED",
          pickup_otp: null,
          is_catering: false,
          headcount: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      },
      { source: "test" },
    );
    expect(evt.event_name).toBe("OrderCreated");
    expect(evt.aggregate_id).toBe(orderId);
    expect(evt.payload.order.total_amount).toBe(245);
    expect(evt.metadata.source).toBe("test");
    expect(EventEnvelopeSchema.safeParse(evt).success).toBe(true);

    const typed: TypedEventEnvelope<"OrderCreated"> = evt;
    expect(typed.event_name).toBe("OrderCreated");
  });

  it("OrderPickedUpEventSchema requires only order_id and restaurant_id (no pickup_otp)", () => {
    const orderId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const parsed = OrderPickedUpEventSchema.safeParse({
      order_id: orderId,
      restaurant_id: orderId,
    });
    expect(parsed.success).toBe(true);
    expect(Object.keys(OrderPickedUpEventSchema.shape)).toEqual([
      "order_id",
      "restaurant_id",
    ]);
    expect(parsed.success ? Object.keys(parsed.data) : []).toEqual([
      "order_id",
      "restaurant_id",
    ]);
  });

  it("registers the J8 successor event alongside the legacy event", () => {
    expect(EventNameSchema.options).toContain("UserLocationObservedAtRestaurant");
    expect(EventNameSchema.options).toContain("UserArrivedAtRestaurant");
  });

  it("UserLocationObservedAtRestaurantEventSchema accepts the exact truthful payload", () => {
    const orderId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const parsed = UserLocationObservedAtRestaurantEventSchema.safeParse({
      order_id: orderId,
      user_id: orderId,
      restaurant_id: orderId,
      distance_m: 42,
      within_fence: false,
      auto_checked_in: false,
    });
    expect(parsed.success).toBe(true);
    expect(Object.keys(UserLocationObservedAtRestaurantEventSchema.shape)).toEqual([
      "order_id",
      "user_id",
      "restaurant_id",
      "distance_m",
      "within_fence",
      "auto_checked_in",
    ]);
  });

  it("UserLocationObservedAtRestaurantEventSchema requires within_fence", () => {
    const orderId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const parsed = UserLocationObservedAtRestaurantEventSchema.safeParse({
      order_id: orderId,
      user_id: orderId,
      restaurant_id: orderId,
      distance_m: 42,
      auto_checked_in: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("UserLocationObservedAtRestaurantEventSchema rejects non-integer or negative distance_m", () => {
    const orderId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const base = {
      order_id: orderId,
      user_id: orderId,
      restaurant_id: orderId,
      within_fence: true,
      auto_checked_in: false,
    };
    expect(
      UserLocationObservedAtRestaurantEventSchema.safeParse({ ...base, distance_m: 42.5 }).success,
    ).toBe(false);
    expect(
      UserLocationObservedAtRestaurantEventSchema.safeParse({ ...base, distance_m: -1 }).success,
    ).toBe(false);
  });

  it("rejects an unknown event name", () => {
    expect(EventNameSchema.safeParse("OrderDelivered").success).toBe(false);
  });
});
