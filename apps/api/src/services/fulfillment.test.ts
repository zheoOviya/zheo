import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================
// Fulfillment service CAS / tx-boundary / event-ordering semantics.
//
// The transaction port is injected and instrumented with an ordered log so we
// can prove: mutations happen inside the tx boundary, and events are emitted
// ONLY after the commit boundary. The memory port is a passthrough
// (MEMORY_ATOMICITY_GUARANTEE = NONE), so this file does NOT claim rollback,
// locking or real concurrency.
// ============================================

const state = vi.hoisted(() => ({
  log: [] as string[],
  events: [] as Array<{ event_name: string; aggregate_id: string; payload: unknown }>,
}));

vi.mock("../lib/eventBus", () => ({
  createEventEnvelope: (
    event_name: string,
    aggregate_id: string,
    payload: unknown,
    metadata: Record<string, unknown> = {},
  ) => ({
    event_id: globalThis.crypto.randomUUID(),
    event_name,
    aggregate_id,
    payload,
    metadata,
  }),
  emit: vi.fn(async (envelope: { event_name: string; aggregate_id: string; payload: unknown }) => {
    state.log.push(`emit:${envelope.event_name}`);
    state.events.push(envelope);
  }),
}));

vi.mock("../lib/websocket", () => ({
  publishStatusUpdate: vi.fn(async () => {
    state.log.push("publish");
  }),
}));

import { FulfillmentService } from "./fulfillment";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import type { OrderDTO } from "../repositories/orderRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import type { GiftDTO } from "../repositories/giftRepository";
import {
  MemoryEventOutboxRepository,
} from "../repositories/eventOutboxRepository";
import type {
  FulfillmentOrderRepo,
  FulfillmentGiftRepo,
  FulfillmentTransactionPort,
} from "../repositories/fulfillmentAtomicityContracts";
import type { OrderStatus } from "@snakzap/types";

const OID = "11111111-1111-4111-8111-111111111111";
const REST_ID = "33333333-3333-4333-8333-333333333333";

function orderDto(
  id: string,
  status: OrderStatus,
  opts: { otp?: string; giftId?: string } = {},
): OrderDTO {
  const now = new Date().toISOString();
  return {
    id,
    user_id: "22222222-2222-4222-8222-222222222222",
    restaurant_id: REST_ID,
    items: opts.giftId
      ? [
          {
            id: randomUUID(),
            menu_item_id: "44444444-4444-4444-8444-444444444444",
            name: "Gift Meal",
            base_price: 0,
            quantity: 1,
            customizations: [],
            customization_total: 0,
            item_subtotal: 0,
            gift_id: opts.giftId,
          },
        ]
      : [],
    total_amount: 100,
    status,
    commission_rate: 0.08,
    commission_amount: 8,
    pickup_otp: opts.otp ?? null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: now,
    updated_at: now,
  };
}

const log = (entry: string): void => {
  state.log.push(entry);
};

class ControllableOrderRepository extends MemoryOrderRepository {
  advanceRace = false;
  consumeRace = false;

  override async transitionStatus(
    orderId: string,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
  ): Promise<OrderDTO | null> {
    log("orders.transitionStatus");
    return super.transitionStatus(orderId, fromStatus, toStatus);
  }

  override async claimPreparingWithOtp(
    orderId: string,
    fromStatus: OrderStatus,
    otp: string,
  ): Promise<OrderDTO | null> {
    log("orders.claimPreparingWithOtp");
    if (this.advanceRace) {
      this.advanceRace = false;
      // A concurrent writer moved the row; our CAS must now miss.
      await this.updateStatus(orderId, "PREPARING");
      return null;
    }
    return super.claimPreparingWithOtp(orderId, fromStatus, otp);
  }

  override async consumePickupOtp(
    orderId: string,
    fromStatus: OrderStatus,
    otp: string,
  ): Promise<OrderDTO | null> {
    log("orders.consumePickupOtp");
    if (this.consumeRace) {
      this.consumeRace = false;
      // Another pickup won the CAS; ours must observe a miss.
      return null;
    }
    return super.consumePickupOtp(orderId, fromStatus, otp);
  }
}

class LoggingOutbox extends MemoryEventOutboxRepository {
  private readonly logFn: (entry: string) => void;
  constructor(logFn: (entry: string) => void) {
    super();
    this.logFn = logFn;
  }

  override async enqueue(envelope: Parameters<MemoryEventOutboxRepository["enqueue"]>[0]): Promise<void> {
    this.logFn(`outbox.enqueue:${envelope.event_name}`);
    await super.enqueue(envelope);
  }
}

class Harness {
  readonly orders = new ControllableOrderRepository();
  readonly gifts = new MemoryGiftRepository();
  readonly outbox = new LoggingOutbox(log);

  /** Controlled failures injected into the tx-scoped gift mutations. */
  txGiftFulfillThrow = false;
  txGiftReleaseThrow = false;

  readonly service: FulfillmentService;

  private readonly txOrders: FulfillmentOrderRepo;
  private readonly txGifts: FulfillmentGiftRepo;

  constructor() {
    this.txOrders = {
      getById: (id) => this.orders.getById(id),
      transitionStatus: (id, from, to) =>
        this.orders.transitionStatus(id, from, to),
      claimPreparingWithOtp: (id, from, otp) =>
        this.orders.claimPreparingWithOtp(id, from, otp),
      consumePickupOtp: (id, from, otp) =>
        this.orders.consumePickupOtp(id, from, otp),
    };
    this.txGifts = {
      releaseFromOrder: (id, orderId) => {
        log("gifts.releaseFromOrder");
        if (this.txGiftReleaseThrow) {
          throw new Error("controlled release failure");
        }
        return this.gifts.releaseFromOrder(id, orderId);
      },
      markFulfilled: (id, orderId) => {
        log("gifts.markFulfilled");
        if (this.txGiftFulfillThrow) {
          throw new Error("controlled fulfill failure");
        }
        return this.gifts.markFulfilled(id, orderId);
      },
    };
    const port: FulfillmentTransactionPort = {
      runInTransaction: async (fn) => {
        log("tx.begin");
        const result = await fn({
          orders: this.txOrders,
          gifts: this.txGifts,
          outbox: this.outbox,
        });
        log("tx.end");
        return result;
      },
    };
    this.service = new FulfillmentService(this.orders, this.gifts, port);
  }

  seed(id: string, status: OrderStatus, opts?: Parameters<typeof orderDto>[2]): OrderDTO {
    return this.orders._seed(orderDto(id, status, opts));
  }

  async claimedGift(): Promise<GiftDTO> {
    const gift = await this.gifts.create({
      sender_id: "55555555-5555-4555-8555-555555555555",
      restaurant_id: REST_ID,
      menu_item_id: "44444444-4444-4444-8444-444444444444",
      item_snapshot: {
        name: "Gift Meal",
        price: 0,
        image_url: null,
        dietary_tags: {},
        spice_level: 0,
        customizations: [],
      },
      price_paid: 100,
      message: null,
      recipient_name: null,
      claim_token: randomUUID(),
      claim_code: "123456",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await this.gifts.markPaid(gift.id);
    await this.gifts.markClaimed(gift.id, "claimer");
    const claimed = await this.gifts.getById(gift.id);
    if (!claimed) throw new Error("gift fixture failed");
    return claimed;
  }
}

const published = (): boolean => state.log.includes("publish");

describe("FulfillmentService CAS + atomicity semantics", () => {
  let h: Harness;

  beforeEach(() => {
    state.log.length = 0;
    state.events.length = 0;
    vi.clearAllMocks();
    h = new Harness();
  });

  // ---------------- advance ----------------

  describe("advanceOrderStatus", () => {
    it("A1 CONFIRMED->PREPARING persists only the OTP via one claim CAS", async () => {
      h.seed(OID, "CONFIRMED");
      const res = await h.service.advanceOrderStatus(OID);
      expect(res.order.status).toBe("PREPARING");
      expect(res.order.pickup_otp).toMatch(/^\d{4}$/);
      expect(state.log).toContain("orders.claimPreparingWithOtp");
      expect(state.log).not.toContain("orders.transitionStatus");
    });

    it("A2 PREPARING->ALMOST_READY uses the plain CAS transition", async () => {
      h.seed(OID, "PREPARING", { otp: "1234" });
      const res = await h.service.advanceOrderStatus(OID);
      expect(res.order.status).toBe("ALMOST_READY");
      expect(state.log).toContain("orders.transitionStatus");
      expect(state.log).not.toContain("orders.claimPreparingWithOtp");
    });

    it("A3 ALMOST_READY->READY_FOR_PICKUP", async () => {
      h.seed(OID, "ALMOST_READY");
      const res = await h.service.advanceOrderStatus(OID);
      expect(res.order.status).toBe("READY_FOR_PICKUP");
    });

    it("A4 terminal state is rejected with INVALID_TRANSITION", async () => {
      h.seed(OID, "PICKED_UP");
      await expect(h.service.advanceOrderStatus(OID)).rejects.toMatchObject({
        code: "INVALID_TRANSITION",
        status: 400,
      });
    });

    it("A5 missing order is ORDER_NOT_FOUND", async () => {
      await expect(h.service.advanceOrderStatus(OID)).rejects.toMatchObject({
        code: "ORDER_NOT_FOUND",
        status: 404,
      });
    });

    it("A6 lost CAS race surfaces CONCURRENT_MODIFICATION 409", async () => {
      h.seed(OID, "CONFIRMED");
      h.orders.advanceRace = true;
      await expect(h.service.advanceOrderStatus(OID)).rejects.toMatchObject({
        code: "CONCURRENT_MODIFICATION",
        status: 409,
      });
    });

    it("A7 lost CAS race emits nothing", async () => {
      h.seed(OID, "CONFIRMED");
      h.orders.advanceRace = true;
      await expect(h.service.advanceOrderStatus(OID)).rejects.toBeTruthy();
      expect(published()).toBe(false);
      expect(state.log.some((e) => e.startsWith("emit:"))).toBe(false);
    });
  });

  // ---------------- OTP pickup ----------------

  describe("confirmPickup via OTP", () => {
    it("P1 valid OTP consumes it and sets PICKED_UP", async () => {
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234" });
      const out = await h.service.confirmPickup(OID, "1234");
      expect(out.status).toBe("PICKED_UP");
      expect(out.pickup_otp).toBeNull();
      expect(state.log).toContain("orders.consumePickupOtp");
    });

    it("P2 fulfills a bound gift inside the same tx boundary", async () => {
      const gift = await h.claimedGift();
      await h.gifts.bindToOrder(gift.id, OID);
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234", giftId: gift.id });
      await h.service.confirmPickup(OID, "1234");
      expect(state.log).toContain("gifts.markFulfilled");
      const begin = state.log.indexOf("tx.begin");
      const fulfill = state.log.indexOf("gifts.markFulfilled");
      const end = state.log.indexOf("tx.end");
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(fulfill).toBeGreaterThan(begin);
      expect(end).toBeGreaterThan(fulfill);
      expect((await h.gifts.getById(gift.id))?.status).toBe("FULFILLED");
    });

    it("P3 invalid OTP is rejected, state intact, nothing emitted", async () => {
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234" });
      await expect(
        h.service.confirmPickup(OID, "9999"),
      ).rejects.toMatchObject({ code: "INVALID_OTP", status: 400 });
      expect((await h.orders.getById(OID))?.status).toBe("READY_FOR_PICKUP");
      expect(published()).toBe(false);
      expect(state.log.some((e) => e.startsWith("emit:"))).toBe(false);
    });

    it("P4 not READY_FOR_PICKUP is rejected as NOT_READY", async () => {
      h.seed(OID, "PREPARING", { otp: "1234" });
      await expect(
        h.service.confirmPickup(OID, "1234"),
      ).rejects.toMatchObject({ code: "NOT_READY", status: 400 });
    });

    it("P5 already picked up is ALREADY_PICKED_UP", async () => {
      h.seed(OID, "PICKED_UP");
      await expect(
        h.service.confirmPickup(OID, "1234"),
      ).rejects.toMatchObject({ code: "ALREADY_PICKED_UP", status: 400 });
    });

    it("P6 no OTP is MISSING_VERIFICATION", async () => {
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234" });
      await expect(h.service.confirmPickup(OID)).rejects.toMatchObject({
        code: "MISSING_VERIFICATION",
        status: 400,
      });
    });

    it("P7 missing order is ORDER_NOT_FOUND", async () => {
      await expect(
        h.service.confirmPickup(OID, "1234"),
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND", status: 404 });
    });

    it("P8 gift markFulfilled throw aborts the tx with zero durable events", async () => {
      const gift = await h.claimedGift();
      await h.gifts.bindToOrder(gift.id, OID);
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234", giftId: gift.id });
      h.txGiftFulfillThrow = true;

      await expect(
        h.service.confirmPickup(OID, "1234"),
      ).rejects.toThrow("controlled fulfill failure");

      const consume = state.log.indexOf("orders.consumePickupOtp");
      const fulfill = state.log.indexOf("gifts.markFulfilled");
      expect(consume).toBeGreaterThanOrEqual(0);
      expect(fulfill).toBeGreaterThan(consume);
      expect(published()).toBe(false);
      expect(h.outbox._all()).toHaveLength(0);
    });

    it("P9 consume CAS miss yields zero gifts/durable events", async () => {
      const gift = await h.claimedGift();
      await h.gifts.bindToOrder(gift.id, OID);
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234", giftId: gift.id });
      h.orders.consumeRace = true;

      await expect(
        h.service.confirmPickup(OID, "1234"),
      ).rejects.toMatchObject({ code: "INVALID_OTP", status: 400 });

      expect(state.log).toContain("orders.consumePickupOtp");
      expect(state.log).not.toContain("gifts.markFulfilled");
      expect(published()).toBe(false);
      expect(h.outbox._all()).toHaveLength(0);
    });
  });

  // ---------------- OTP-only credential ----------------

  describe("confirmPickup OTP-only", () => {
    it("R1 a legacy qr_token value is not a valid pickup credential", async () => {
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234" });
      await expect(h.service.confirmPickup(OID, "qr-abc")).rejects.toMatchObject({
        code: "INVALID_OTP",
        status: 400,
      });
    });

    it("R2 a matching OTP consumes the order", async () => {
      const gift = await h.claimedGift();
      await h.gifts.bindToOrder(gift.id, OID);
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234", giftId: gift.id });
      const out = await h.service.confirmPickup(OID, "1234");
      expect(out.status).toBe("PICKED_UP");
      expect((await h.gifts.getById(gift.id))?.status).toBe("FULFILLED");
    });
  });

  // ---------------- event ordering ----------------

  describe("post-commit event ordering", () => {
    it("E1 advance enqueues OrderPreparationStarted inside the tx, then publishes", async () => {
      h.seed(OID, "CONFIRMED");
      await h.service.advanceOrderStatus(OID);
      const claim = state.log.indexOf("orders.claimPreparingWithOtp");
      const enqueue = state.log.indexOf("outbox.enqueue:OrderPreparationStarted");
      const commit = state.log.indexOf("tx.end");
      const publish = state.log.indexOf("publish");
      expect(claim).toBeGreaterThanOrEqual(0);
      expect(enqueue).toBeGreaterThan(claim);
      expect(commit).toBeGreaterThan(enqueue);
      expect(publish).toBeGreaterThan(commit);
    });

    it("E2 pickup commits (with durable events enqueued inside the tx) before publishing", async () => {
      const gift = await h.claimedGift();
      await h.gifts.bindToOrder(gift.id, OID);
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234", giftId: gift.id });
      await h.service.confirmPickup(OID, "1234");
      const consume = state.log.indexOf("orders.consumePickupOtp");
      const giftMark = state.log.indexOf("gifts.markFulfilled");
      const picked = state.log.indexOf("outbox.enqueue:OrderPickedUp");
      const fulfilled = state.log.indexOf("outbox.enqueue:GiftFulfilled");
      const commit = state.log.indexOf("tx.end");
      const publish = state.log.indexOf("publish");
      expect(consume).toBeGreaterThanOrEqual(0);
      expect(giftMark).toBeGreaterThan(consume);
      expect(picked).toBeGreaterThan(giftMark);
      expect(fulfilled).toBeGreaterThan(picked);
      expect(commit).toBeGreaterThan(fulfilled);
      expect(publish).toBeGreaterThan(commit);
    });

    it("E3 rejected pickup emits no publish/durable event", async () => {
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234" });
      await expect(
        h.service.confirmPickup(OID, "0000"),
      ).rejects.toBeTruthy();
      expect(published()).toBe(false);
      expect(h.outbox._all()).toHaveLength(0);
    });

    it("E4 OrderPickedUp outbox payload carries order_id/restaurant_id and no pickup_otp", async () => {
      h.seed(OID, "READY_FOR_PICKUP", { otp: "1234" });
      await h.service.confirmPickup(OID, "1234");

      const pickedUp = h.outbox._all().find((r) => r.event_name === "OrderPickedUp");
      expect(pickedUp).toBeDefined();
      const payload = pickedUp?.payload as Record<string, unknown>;
      expect(payload.order_id).toBe(OID);
      expect(payload.restaurant_id).toBe(REST_ID);
      expect(Object.keys(payload).sort()).toEqual(["order_id", "restaurant_id"]);
      expect("pickup_otp" in payload).toBe(false);
    });
  });
});
