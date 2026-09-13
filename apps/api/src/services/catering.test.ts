import { beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus } from "@snakzap/types";
import { onEvent } from "../lib/eventBus";
import { resetRedisForTests } from "../lib/redis";
import {
  type CreateOrderInput,
  MemoryOrderRepository,
} from "../repositories/orderRepository";
import { getCatalogRepository, resetCatalogRepository } from "../routes/catalog";
import { CateringService, type CateringOrderRequest } from "./catering";

// ============================================
// CATERING-STATE-TRUTH-A2 unit coverage (U1-U6).
//
// Catering confirmation must be a from-state CAS (DRAFT -> CONFIRMED), never a
// blind update. A CAS miss must raise the existing CATERING_CONFIRM_FAILED and
// emit zero CateringOrderCreated events. Create and confirm stay separate
// commits, so no atomicity/rollback is claimed here (real CAS truth is proven
// by the real-PG harness).
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const CHICKEN_BIRYANI = "b0000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000f1";
const FUTURE = "2099-09-01T10:30:00+05:30";

interface TransitionCall {
  id: string;
  from: OrderStatus;
  to: OrderStatus;
}

/**
 * MemoryOrderRepository with instrumentation: records every status mutation so
 * the tests can prove the service uses transitionStatus (not updateStatus), and
 * can simulate a concurrent terminal write landing between create and confirm.
 */
class InstrumentedOrderRepo extends MemoryOrderRepository {
  transitionCalls: TransitionCall[] = [];
  updateStatusCalls: { id: string; status: OrderStatus }[] = [];
  blindConfirmUsed = false;
  forceTransitionNull = false;
  postCreateStatus: OrderStatus | null = null;

  override async create(input: CreateOrderInput) {
    const order = await super.create(input);
    if (this.postCreateStatus) {
      await super.updateStatus(order.id, this.postCreateStatus);
    }
    return order;
  }

  override async transitionStatus(
    orderId: string,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
  ) {
    this.transitionCalls.push({ id: orderId, from: fromStatus, to: toStatus });
    if (this.forceTransitionNull) return null;
    return super.transitionStatus(orderId, fromStatus, toStatus);
  }

  override async updateStatus(orderId: string, status: OrderStatus) {
    this.updateStatusCalls.push({ id: orderId, status });
    if (status === "CONFIRMED") this.blindConfirmUsed = true;
    return super.updateStatus(orderId, status);
  }
}

function request(overrides: Partial<CateringOrderRequest> = {}): CateringOrderRequest {
  return {
    user_id: USER_ID,
    restaurant_id: REST_ID,
    event_date: FUTURE,
    headcount: 150,
    items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 100 }],
    ...overrides,
  };
}

describe("CateringService state truth (A2)", () => {
  let orderRepo: InstrumentedOrderRepo;
  let service: CateringService;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    orderRepo = new InstrumentedOrderRepo();
    service = new CateringService(orderRepo, getCatalogRepository());
  });

  it("U1 creates DRAFT then CAS DRAFT->CONFIRMED", async () => {
    const order = await service.placeCateringOrder(request());

    expect(order.status).toBe("CONFIRMED");
    expect(orderRepo.transitionCalls).toEqual([
      { id: order.id, from: "DRAFT", to: "CONFIRMED" },
    ]);
    expect(orderRepo.blindConfirmUsed).toBe(false);
    expect((await orderRepo.getById(order.id))?.status).toBe("CONFIRMED");
  });

  it("U2 a CAS miss (already CONFIRMED) preserves CATERING_CONFIRM_FAILED", async () => {
    orderRepo.postCreateStatus = "CONFIRMED";

    await expect(service.placeCateringOrder(request())).rejects.toMatchObject({
      code: "CATERING_CONFIRM_FAILED",
      status: 500,
    });
    expect(orderRepo.transitionCalls[0]).toMatchObject({
      from: "DRAFT",
      to: "CONFIRMED",
    });
  });

  it.each(["CANCELLED", "PICKED_UP"] as const)(
    "U3 a terminal %s state is never blind-overwritten",
    async (terminal) => {
      orderRepo.postCreateStatus = terminal;

      await expect(service.placeCateringOrder(request())).rejects.toMatchObject({
        code: "CATERING_CONFIRM_FAILED",
      });

      const orders = await orderRepo.getAll();
      expect(orders).toHaveLength(1);
      expect(orders[0]?.status).toBe(terminal);
      expect(orderRepo.blindConfirmUsed).toBe(false);
    },
  );

  it("U4 a CAS miss yields the existing service error contract", async () => {
    orderRepo.forceTransitionNull = true;

    await expect(service.placeCateringOrder(request())).rejects.toMatchObject({
      code: "CATERING_CONFIRM_FAILED",
      status: 500,
      message: "Failed to confirm catering order",
    });
    expect(orderRepo.updateStatusCalls.some((c) => c.status === "CONFIRMED")).toBe(
      false,
    );
  });

  it("U5 a CAS miss emits ZERO CateringOrderCreated events", async () => {
    const seen: string[] = [];
    onEvent("CateringOrderCreated", async () => {
      seen.push("CateringOrderCreated");
    });
    orderRepo.forceTransitionNull = true;

    await expect(service.placeCateringOrder(request())).rejects.toMatchObject({
      code: "CATERING_CONFIRM_FAILED",
    });

    expect(seen).toEqual([]);
  });

  it("U6 the transition commits before CateringOrderCreated is emitted", async () => {
    let statusAtEmit: OrderStatus | null = null;
    let emitCount = 0;
    onEvent("CateringOrderCreated", async () => {
      emitCount += 1;
      const orders = await orderRepo.getAll();
      statusAtEmit = orders[0]?.status ?? null;
    });

    const order = await service.placeCateringOrder(request());

    expect(order.status).toBe("CONFIRMED");
    expect(emitCount).toBe(1);
    expect(statusAtEmit).toBe("CONFIRMED");
  });
});
