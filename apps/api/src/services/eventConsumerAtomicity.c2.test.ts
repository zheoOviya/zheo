import { beforeEach, describe, expect, it } from "vitest";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { resetRedisForTests } from "../lib/redis";
import {
  __resetConsumerTransactionPortForTests,
  getConsumerTransactionPort,
} from "../repositories/drizzle/consumerTransactionPort";
import {
  sharedAuditRepo,
  sharedLoyaltyRepo,
  sharedNotificationRepo,
  sharedOrderRepo,
  sharedPromotionRepo,
} from "../repositories/shared";
import type { OrderDTO } from "../repositories/orderRepository";
import { registerRetentionEventHandlers } from "./retention";
import { registerLoyaltyEventHandlers } from "./loyalty";
import { registerVendorNotificationHandlers } from "./notifications";

// ============================================
// EVT-C2 durable consumer atomic idempotency (memory-mode behavior).
//
// These tests prove the CONSUMER-SIDE dedup (a redelivered event performs zero
// business mutation) and the strict-publish failure propagation seam. Memory
// mode has MEMORY_ATOMICITY_GUARANTEE=NONE, so the same-transaction rollback
// proof lives exclusively in the real-PostgreSQL harness
// (apps/api/integration/realPgConsumerAtomicity.ts).
// ============================================

registerRetentionEventHandlers();
registerLoyaltyEventHandlers();
registerVendorNotificationHandlers();

const USER_ID = "00000000-0000-4000-8000-0000000000c1";
const REST_ID = "a0000000-0000-4000-8000-000000000001";
const APPLICANT_ID = "00000000-0000-4000-8000-000000000001";
const VENDOR_ID = "00000000-0000-4000-8000-000000000002";

async function seedOrder(totalAmount: number): Promise<OrderDTO> {
  const created = await sharedOrderRepo.create({
    user_id: USER_ID,
    restaurant_id: REST_ID,
    items: [],
    breakdown: {
      items: [],
      food_subtotal: totalAmount,
      packaging_fee: 0,
      packaging_fee_per_item: 0,
      gst_food: 0,
      gst_packaging: 0,
      total_amount: totalAmount,
      commission_rate: 0,
      commission_amount: 0,
    },
  });
  return (await sharedOrderRepo.updateStatus(created.id, "PICKED_UP"))!;
}

function orderPickedUpEvent(orderId: string) {
  return createEventEnvelope("OrderPickedUp", orderId, { order_id: orderId });
}

beforeEach(() => {
  resetRedisForTests();
  sharedOrderRepo._reset();
  sharedLoyaltyRepo._reset();
  sharedPromotionRepo._reset();
  sharedNotificationRepo._reset();
  sharedAuditRepo._reset();
  __resetConsumerTransactionPortForTests();
});

describe("EVT-C2 cashback consumer (retention.cashback)", () => {
  it("C2-CASH-1: a redelivered event credits the wallet exactly once", async () => {
    const order = await seedOrder(500);
    const event = orderPickedUpEvent(order.id);

    await emit(event);
    await emit(event);

    const wallet = await sharedLoyaltyRepo.getWallet(USER_ID);
    expect(wallet.balance).toBe(5);
    const ledger = await sharedLoyaltyRepo.getWalletTransactions(USER_ID);
    expect(ledger.filter((t) => t.reason === "pickup_cashback")).toHaveLength(1);
  });

  it("C2-CASH-2: distinct events each credit once", async () => {
    const a = await seedOrder(250);
    const b = await seedOrder(250);

    await emit(orderPickedUpEvent(a.id));
    await emit(orderPickedUpEvent(b.id));

    const wallet = await sharedLoyaltyRepo.getWallet(USER_ID);
    expect(wallet.balance).toBe(5);
    expect(await sharedLoyaltyRepo.getWalletTransactions(USER_ID)).toHaveLength(2);
  });
});

describe("EVT-C2 streak consumer (retention.streak)", () => {
  it("C2-STREAK-1: a redelivered badge event mints exactly one coupon", async () => {
    const base = new Date();
    const dayKey = (daysAgo: number) =>
      new Date(base.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    for (let i = 6; i >= 1; i -= 1) {
      await sharedLoyaltyRepo.recordPickup(USER_ID, dayKey(i));
    }
    const order = await seedOrder(100);
    const event = orderPickedUpEvent(order.id);

    await emit(event);
    await emit(event);

    expect((await sharedLoyaltyRepo.getStreak(USER_ID)).current_streak).toBe(7);
    const promos = await sharedPromotionRepo.listActive();
    expect(
      promos.filter((p) => p.value === 10 && p.discount_type === "PERCENTAGE"),
    ).toHaveLength(1);
  });

  it("C2-STREAK-2: a distinct same-day event does not advance the streak again", async () => {
    const first = await seedOrder(100);
    await emit(orderPickedUpEvent(first.id));
    const second = await seedOrder(100);
    await emit(orderPickedUpEvent(second.id));

    const streak = await sharedLoyaltyRepo.getStreak(USER_ID);
    expect(streak.current_streak).toBe(1);
  });
});

describe("EVT-C2 stamp consumer (loyalty.order_stamp)", () => {
  it("C2-STAMP-1: a redelivered event increments the stamp card exactly once", async () => {
    const order = await seedOrder(100);
    const event = orderPickedUpEvent(order.id);

    await emit(event);
    await emit(event);

    const card = await sharedLoyaltyRepo.getStampCard(USER_ID, REST_ID);
    expect(card?.stamp_count).toBe(1);
    expect(card?.total_orders).toBe(1);
  });

  it("C2-STAMP-2: distinct events each increment once", async () => {
    const a = await seedOrder(100);
    const b = await seedOrder(100);

    await emit(orderPickedUpEvent(a.id));
    await emit(orderPickedUpEvent(b.id));

    const card = await sharedLoyaltyRepo.getStampCard(USER_ID, REST_ID);
    expect(card?.stamp_count).toBe(2);
  });
});

describe("EVT-C2 notification consumers", () => {
  it("C2-NOTIF-1: a redelivered approval enqueues sms+email exactly once", async () => {
    const event = createEventEnvelope("VendorApplicationApproved", "app-1", {
      applicant_id: APPLICANT_ID,
      name: "Spice Route",
      phone: "+9100000001",
      contact_email: "owner@spiceroute.com",
      vendor_id: VENDOR_ID,
    });

    await emit(event);
    await emit(event);

    const all = await sharedNotificationRepo.listAll();
    expect(all.filter((n) => n.channel === "sms")).toHaveLength(1);
    expect(all.filter((n) => n.channel === "email")).toHaveLength(1);
  });

  it("C2-NOTIF-2: approved and rejected are independent consumers for one event_id", async () => {
    const approved = createEventEnvelope("VendorApplicationApproved", "app-2", {
      applicant_id: APPLICANT_ID,
      name: "Spice Route",
      phone: "+9100000001",
      contact_email: null,
      vendor_id: VENDOR_ID,
    });
    const rejected = createEventEnvelope("VendorApplicationRejected", "app-2", {
      applicant_id: APPLICANT_ID,
      name: "Spice Route",
      phone: "+9100000001",
      contact_email: null,
      reason: "GST mismatch",
    });
    // Same event_id as the approval: a DIFFERENT consumer must not be suppressed.
    const rejectedSameId = { ...rejected, event_id: approved.event_id };

    await emit(approved);
    await emit(rejectedSameId);
    await emit(rejectedSameId);

    const all = await sharedNotificationRepo.listAll();
    expect(all.filter((n) => n.channel === "sms")).toHaveLength(2);
  });
});

describe("EVT-C2 consumer transaction port", () => {
  it("C2-TX-1: runInTransaction exposes the scope and returns the callback value", async () => {
    const value = await getConsumerTransactionPort().runInTransaction(
      async (scope) => {
        expect(typeof scope.claim).toBe("function");
        expect(scope.loyalty).toBeDefined();
        expect(scope.orders).toBeDefined();
        expect(scope.promotions).toBeDefined();
        expect(scope.notifications).toBeDefined();
        return 42;
      },
    );
    expect(value).toBe(42);
  });

  it("C2-TX-2: claim wins once and loses on the duplicate pair", async () => {
    const port = getConsumerTransactionPort();
    const first = await port.runInTransaction((scope) =>
      scope.claim("c2.tx2", "11111111-1111-4111-8111-111111111111"),
    );
    const second = await port.runInTransaction((scope) =>
      scope.claim("c2.tx2", "11111111-1111-4111-8111-111111111111"),
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("C2-TX-3: a callback error propagates out of runInTransaction", async () => {
    await expect(
      getConsumerTransactionPort().runInTransaction(async () => {
        throw new Error("c2.tx3-boom");
      }),
    ).rejects.toThrow("c2.tx3-boom");
  });
});
