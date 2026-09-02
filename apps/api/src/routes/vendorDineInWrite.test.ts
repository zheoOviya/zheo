import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { resetCatalogRepository } from "./catalog";
import {
  getDineInOrderReadRepository,
  getDineInTransactionPort,
  resetDineInState,
} from "../repositories/dineInComposition";
import {
  sharedChainRepo,
  sharedUserRoleRepo,
} from "../repositories/shared";
import type {
  DineInOrderWithItemsDTO,
  DineInTransactionRepos,
  DiningSessionDTO,
  RestaurantTableDTO,
} from "../repositories/dineInContracts";

// ============================================
// DINE-OPS1.3 vendor Dine-In order write wrappers:
//   POST /api/vendor/dine-in/orders/:orderId/advance
//   POST /api/vendor/dine-in/orders/:orderId/cancel
//
// Product-functional wrapper over the frozen Dine-In order transitions.
// Restaurant identity for authorization is derived SERVER-SIDE from the
// persisted order — never from body/query. Unauthorized restaurants must not
// reach the service mutation (zero mutation on 403/409-unauthorized).
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001"; // Biryani House
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002"; // Green Bowl
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner
const GREEN_OWNER_ID = "e0000000-0000-4000-a000-000000000002"; // Green Bowl owner
const STAFF_ID = "e0000000-0000-4000-a000-000000000099"; // scoped Biryani House staff
const CONSUMER_ID = "u00000000-0000-4000-8000-000000000001";

const ORDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"; // Biryani House order
const ORDER_B = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"; // Biryani House order
const ORDER_UNKNOWN = "11111111-1111-4111-8111-111111111111";

function authHeaders(userId?: string, role?: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId ?? OWNER_ID,
      phone: "+919876543210",
      role: role ?? "VENDOR_OWNER",
      device_fingerprint: "fp_test_device_abc1234",
    })}`,
  };
}

function makeTable(
  id: string,
  restaurantId: string,
  label: string,
): RestaurantTableDTO {
  return {
    id,
    restaurant_id: restaurantId,
    zone_id: null,
    label,
    table_token: `token-${id}`,
    seat_count: 4,
    is_active: true,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
}

function makeSession(
  id: string,
  restaurantId: string,
  tableId: string,
  status: DiningSessionDTO["status"] = "ACTIVE",
): DiningSessionDTO {
  return {
    id,
    restaurant_id: restaurantId,
    table_id: tableId,
    owner_user_id: CONSUMER_ID,
    status,
    bill_requested_at: status === "BILL_REQUESTED" ? "2026-08-24T11:00:00.000Z" : null,
    payment_pending_at: status === "PAYMENT_PENDING" ? "2026-08-24T11:00:00.000Z" : null,
    closed_at: status === "CLOSED" ? "2026-08-24T11:00:00.000Z" : null,
    created_at: "2026-08-24T10:00:00.000Z",
    updated_at: "2026-08-24T10:00:00.000Z",
  };
}

function makeOrder(
  id: string,
  restaurantId: string,
  sessionId: string,
  status: DineInOrderWithItemsDTO["status"],
  createdAt = "2026-08-24T10:05:00.000Z",
): DineInOrderWithItemsDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    placed_by: CONSUMER_ID,
    status,
    total_amount: 462,
    notes: null,
    served_at: null,
    cancelled_at: null,
    cancelled_by: null,
    created_at: createdAt,
    updated_at: createdAt,
    items: [
      {
        id: `itm-${id}`,
        dine_in_order_id: id,
        restaurant_id: restaurantId,
        menu_item_id: "b0000000-0000-4000-8000-000000000001",
        name: "Chicken Biryani",
        base_price: 220,
        quantity: 2,
        customizations: [],
        customization_total: 0,
        item_subtotal: 440,
        created_at: createdAt,
      },
    ],
  };
}

function sharedRepos(): DineInTransactionRepos {
  return (getDineInTransactionPort() as unknown as {
    repos: DineInTransactionRepos;
  }).repos;
}

/** Seeds one order under Biryani House (REST_ID), session under ACTIVE. */
function seedOrder(
  orderId: string,
  status: DineInOrderWithItemsDTO["status"],
  sessionStatus: DiningSessionDTO["status"] = "ACTIVE",
  sessionId = "s1",
) {
  const repos = sharedRepos();
  (repos.restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  })._seed(makeTable("t1", REST_ID, "T1"));
  (repos.diningSessions as unknown as {
    _seed(s: DiningSessionDTO): DiningSessionDTO;
  })._seed(makeSession(sessionId, REST_ID, "t1", sessionStatus));
  (repos.dineInOrders as unknown as {
    _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
  })._seed(makeOrder(orderId, REST_ID, sessionId, status));
}

async function currentStatus(orderId: string): Promise<string | null> {
  const order = await getDineInOrderReadRepository().getById(orderId);
  return order?.status ?? null;
}

describe("Vendor Dine-In order write wrappers (DINE-OPS1.3)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    resetDineInState();
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
    app = createApp();
  });

  // ---- mount-level auth ---------------------------------------------------

  it("1. no token is rejected at the vendor mount (advance + cancel)", async () => {
    seedOrder(ORDER_A, "PLACED");
    await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .send({ target_status: "PREPARING" })
      .expect(401);
    await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/cancel`)
      .expect(401);
  });

  it("2. CONSUMER role is rejected at the vendor mount (advance + cancel)", async () => {
    seedOrder(ORDER_A, "PLACED");
    await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .send({ target_status: "PREPARING" })
      .expect(403);
    await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/cancel`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
  });

  it("3. vendor without restaurant access gets FORBIDDEN with ZERO mutation", async () => {
    seedOrder(ORDER_A, "PLACED");
    await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "PREPARING" })
      .expect(403);
    expect(await currentStatus(ORDER_A)).toBe("PLACED");
  });

  it("4. client cannot spoof ownership via body/query restaurant_id", async () => {
    // Order belongs to Biryani House; attacker is Green Bowl owner and tries
    // to inject their own restaurant_id in body AND query. The wrapper derives
    // restaurant from the persisted order, so access is refused and no
    // mutation occurs.
    seedOrder(ORDER_A, "PLACED");
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance?restaurant_id=${GREEN_BOWL_ID}`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "PREPARING", restaurant_id: GREEN_BOWL_ID })
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(await currentStatus(ORDER_A)).toBe("PLACED");
  });

  // ---- advance transitions ------------------------------------------------

  it("5. owner advances PLACED -> PREPARING -> READY_TO_SERVE -> SERVED", async () => {
    seedOrder(ORDER_A, "PLACED");
    const r1 = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "PREPARING" })
      .expect(200);
    expect(r1.body.data.order.status).toBe("PREPARING");

    const r2 = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "READY_TO_SERVE" })
      .expect(200);
    expect(r2.body.data.order.status).toBe("READY_TO_SERVE");

    const r3 = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "SERVED" })
      .expect(200);
    expect(r3.body.data.order.status).toBe("SERVED");
    // served_at is server-generated, not client supplied.
    expect(typeof r3.body.data.order.served_at).toBe("string");
  });

  it("6. scoped staff member can advance with correct access", async () => {
    seedOrder(ORDER_A, "PLACED");
    sharedUserRoleRepo._seed({
      id: "ur-staff-1",
      user_id: STAFF_ID,
      scope_type: "restaurant",
      scope_id: REST_ID,
      role: "VENDOR_STAFF",
      created_at: "2026-08-24T00:00:00.000Z",
    });
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(STAFF_ID, "VENDOR_STAFF"))
      .send({ target_status: "PREPARING" })
      .expect(200);
    expect(res.body.data.order.status).toBe("PREPARING");
  });

  it("7. invalid advance target is a VALIDATION_ERROR 400", async () => {
    seedOrder(ORDER_A, "PLACED");
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "CANCELLED" })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await currentStatus(ORDER_A)).toBe("PLACED");
  });

  it("8. non-UUID orderId is a VALIDATION_ERROR 400", async () => {
    await request(app)
      .post(`/api/vendor/dine-in/orders/not-a-uuid/advance`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "PREPARING" })
      .expect(400);
    await request(app)
      .post(`/api/vendor/dine-in/orders/not-a-uuid/cancel`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
  });

  it("9. skip/backward invalid transition -> existing 409", async () => {
    seedOrder(ORDER_A, "PLACED");
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "SERVED" })
      .expect(409);
    expect(res.body.error.code).toBe("INVALID_DINE_IN_TRANSITION");
    expect(await currentStatus(ORDER_A)).toBe("PLACED");
  });

  it("10. same-target advance stays idempotent (existing service behavior)", async () => {
    seedOrder(ORDER_A, "PREPARING");
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "PREPARING" })
      .expect(200);
    expect(res.body.data.order.status).toBe("PREPARING");
  });

  // ---- cancel transitions -------------------------------------------------

  it("11. cancel PLACED -> CANCELLED, cancelled_by is the caller", async () => {
    seedOrder(ORDER_A, "PLACED");
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/cancel`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(res.body.data.order.status).toBe("CANCELLED");
    expect(res.body.data.order.cancelled_by).toBe(OWNER_ID);
    expect(typeof res.body.data.order.cancelled_at).toBe("string");
  });

  it("12. cancel PREPARING -> CANCELLED by scoped staff (audit = staff caller)", async () => {
    seedOrder(ORDER_A, "PREPARING");
    sharedUserRoleRepo._seed({
      id: "ur-staff-1",
      user_id: STAFF_ID,
      scope_type: "restaurant",
      scope_id: REST_ID,
      role: "VENDOR_STAFF",
      created_at: "2026-08-24T00:00:00.000Z",
    });
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/cancel`)
      .set(authHeaders(STAFF_ID, "VENDOR_STAFF"))
      .expect(200);
    expect(res.body.data.order.status).toBe("CANCELLED");
    expect(res.body.data.order.cancelled_by).toBe(STAFF_ID);
    expect(typeof res.body.data.order.cancelled_at).toBe("string");
  });

  it("13. READY_TO_SERVE / SERVED cancellation -> existing 409", async () => {
    seedOrder(ORDER_A, "READY_TO_SERVE");
    const r1 = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/cancel`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(r1.body.error.code).toBe("ORDER_NOT_CANCELLABLE");

    seedOrder(ORDER_B, "SERVED");
    const r2 = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_B}/cancel`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(r2.body.error.code).toBe("ORDER_NOT_CANCELLABLE");
  });

  it("14. billed/frozen session cancellation behavior unchanged (BILL_FROZEN 409)", async () => {
    seedOrder(ORDER_A, "PLACED", "BILL_REQUESTED");
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/cancel`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(res.body.error.code).toBe("BILL_FROZEN");
    expect(await currentStatus(ORDER_A)).toBe("PLACED");
  });

  it("15. cancellation audit fields cannot be client supplied", async () => {
    seedOrder(ORDER_A, "PLACED");
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/cancel`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({
        cancelled_by: "attacker-id",
        cancelled_at: "2099-01-01T00:00:00.000Z",
      })
      .expect(200);
    expect(res.body.data.order.cancelled_by).toBe(OWNER_ID);
    expect(res.body.data.order.cancelled_at).not.toBe("2099-01-01T00:00:00.000Z");
    expect(typeof res.body.data.order.cancelled_at).toBe("string");
  });

  it("16. cross-restaurant mutation is ZERO for advance AND cancel", async () => {
    seedOrder(ORDER_A, "PLACED"); // Biryani House order
    await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "PREPARING" })
      .expect(403);
    expect(await currentStatus(ORDER_A)).toBe("PLACED");

    seedOrder(ORDER_B, "PREPARING");
    await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_B}/cancel`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(await currentStatus(ORDER_B)).toBe("PREPARING");
  });

  it("17. unknown order -> ORDER_NOT_FOUND 404 (advance + cancel)", async () => {
    const r1 = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_UNKNOWN}/advance`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({ target_status: "PREPARING" })
      .expect(404);
    expect(r1.body.error.code).toBe("ORDER_NOT_FOUND");

    const r2 = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_UNKNOWN}/cancel`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(404);
    expect(r2.body.error.code).toBe("ORDER_NOT_FOUND");
  });

  it("18. ADMIN bypasses restaurant ownership (platform oversight)", async () => {
    seedOrder(ORDER_A, "PLACED");
    const res = await request(app)
      .post(`/api/vendor/dine-in/orders/${ORDER_A}/advance`)
      .set(authHeaders("00000000-0000-4000-8000-0000000000aa", "ADMIN"))
      .send({ target_status: "PREPARING" })
      .expect(200);
    expect(res.body.data.order.status).toBe("PREPARING");
  });
});
