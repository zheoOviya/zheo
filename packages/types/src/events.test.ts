import { describe, expect, it } from "vitest";
import { createEvent, EventEnvelopeSchema, EventNameSchema, TypedEventEnvelope } from "./events";

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

  it("EventNameSchema contains all 32 core events plus the 6 Dine-In events", () => {
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

  it("rejects an unknown event name", () => {
    expect(EventNameSchema.safeParse("OrderDelivered").success).toBe(false);
  });
});
