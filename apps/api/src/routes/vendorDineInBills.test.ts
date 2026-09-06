import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  DiningSessionStatus,
  DineInOrderStatus,
  ServiceRequestStatus,
} from "@snakzap/types";
import type {
  DineInOrderWithItemsDTO,
  DiningSessionDTO,
  DineZoneDTO,
  RestaurantTableDTO,
  ServiceRequestDTO,
  SessionBillDTO,
  DineInTransactionRepos,
} from "../repositories/dineInContracts";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { resetCatalogRepository } from "./catalog";
import {
  getDineInTableBoardReadRepository,
  getDineInTransactionPort,
  resetDineInState,
} from "../repositories/dineInComposition";
import { sharedChainRepo, sharedUserRoleRepo } from "../repositories/shared";

// ============================================
// DINE-OPS4-B1 vendor Dine-In bill routes:
//   GET  /api/vendor/dine-in/bills?restaurant_id=<uuid>
//   GET  /api/vendor/dine-in/bills/:billId
//   POST /api/vendor/dine-in/bills/:billId/acknowledge
//   POST /api/vendor/dine-in/bills/:billId/deliver
//
// The wire DTOs (VendorPendingBillRow / VendorBillDetail) are FROZEN
// (DINE-OPS4-A1R1/A1R2): queue membership is session.status === "BILL_REQUESTED"
// AND BRING_BILL PENDING/ACKNOWLEDGED, ordered bill_requested_at ASC then
// bill.id ASC; COMPLETED leaves the queue while the detail stays readable;
// actions are legal only while BILL_REQUESTED. Authorization is
// billId -> access context (404) -> restaurant gate (403) -> post-auth
// invariant (500) -> action boundary (409) -> frozen service. Restaurant
// identity is derived from the persisted bill, never body/query; no
// owner_user_id / requested_by / table_token / payment / settlement /
// close-session field is exposed or accepted.
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001"; // Biryani House
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002"; // Green Bowl
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner
const GREEN_OWNER_ID = "e0000000-0000-4000-a000-000000000002"; // Green Bowl owner
const STAFF_ID = "e0000000-0000-4000-a000-000000000099"; // scoped Biryani House staff
const ADMIN_ID = "00000000-0000-4000-8000-0000000000aa";
const CONSUMER_ID = "u00000000-0000-4000-8000-000000000001";

const TABLE_1 = "10000000-0000-4000-8000-000000000001";
const TABLE_2 = "20000000-0000-4000-8000-000000000001";
const TABLE_G = "30000000-0000-4000-8000-000000000001";
const ZONE_1 = "40000000-0000-4000-8000-000000000001";

const SESSION_1 = "50000000-0000-4000-8000-000000000001";
const SESSION_2 = "60000000-0000-4000-8000-000000000001";
const SESSION_3 = "70000000-0000-4000-8000-000000000001";
const SESSION_G = "80000000-0000-4000-8000-000000000001";

const BILL_1 = "a1000000-0000-4000-8000-000000000001";
const BILL_2 = "a2000000-0000-4000-8000-000000000001";
const BILL_3 = "a3000000-0000-4000-8000-000000000001";
const BILL_G = "a4000000-0000-4000-8000-000000000001";
const BILL_UNKNOWN = "99999999-9999-4999-8999-999999999999";

const REQ_BILL_1 = "b1000000-0000-4000-8000-000000000001";
const REQ_BILL_2 = "b2000000-0000-4000-8000-000000000001";
const REQ_BILL_3 = "b3000000-0000-4000-8000-000000000001";
const REQ_BILL_G = "b4000000-0000-4000-8000-000000000001";

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

function makeTable(id: string, restaurantId: string, label: string): RestaurantTableDTO {
  return {
    id,
    restaurant_id: restaurantId,
    zone_id: id === TABLE_1 ? ZONE_1 : null,
    label,
    table_token: `token-${id}`,
    seat_count: 4,
    is_active: true,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
}

function makeZone(id: string, restaurantId: string, name: string): DineZoneDTO {
  return {
    id,
    restaurant_id: restaurantId,
    name,
    is_active: true,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
}

function makeSession(
  id: string,
  restaurantId: string,
  tableId: string,
  status: DiningSessionStatus,
  createdAt: string,
  billRequestedAt: string | null,
): DiningSessionDTO {
  return {
    id,
    restaurant_id: restaurantId,
    table_id: tableId,
    owner_user_id: CONSUMER_ID,
    status,
    bill_requested_at: billRequestedAt,
    payment_pending_at: null,
    closed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function makeBill(
  id: string,
  sessionId: string,
  restaurantId: string,
  frozenAt: string,
): SessionBillDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    food_subtotal: 200,
    packaging_fee: 0,
    gst_food: 10,
    gst_packaging: 0,
    total_amount: 210,
    frozen_at: frozenAt,
    created_at: frozenAt,
  };
}

function makeBringBill(
  id: string,
  sessionId: string,
  restaurantId: string,
  status: ServiceRequestStatus,
  createdAt: string,
): ServiceRequestDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    requested_by: CONSUMER_ID,
    request_type: "BRING_BILL",
    status,
    note: null,
    acknowledged_by: null,
    acknowledged_at: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function makeOrder(
  id: string,
  sessionId: string,
  restaurantId: string,
  status: DineInOrderStatus,
  createdAt: string,
): DineInOrderWithItemsDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    placed_by: CONSUMER_ID,
    status,
    total_amount: 200,
    notes: null,
    served_at: status === "SERVED" ? "2026-08-24T10:00:00.000Z" : null,
    cancelled_at: status === "CANCELLED" ? "2026-08-24T10:00:00.000Z" : null,
    cancelled_by: status === "CANCELLED" ? CONSUMER_ID : null,
    created_at: createdAt,
    updated_at: createdAt,
    items: [
      {
        id: `item-${id}`,
        dine_in_order_id: id,
        restaurant_id: restaurantId,
        menu_item_id: "menu-1",
        name: "Paneer Tikka",
        base_price: 100,
        quantity: 2,
        customizations: [],
        customization_total: 0,
        item_subtotal: 200,
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

function seedTable(tableId: string, restaurantId: string, label: string) {
  const repos = sharedRepos();
  (repos.restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  })._seed(makeTable(tableId, restaurantId, label));
}

function seedSession(dto: DiningSessionDTO) {
  const repos = sharedRepos();
  (repos.diningSessions as unknown as {
    _seed(s: DiningSessionDTO): DiningSessionDTO;
  })._seed(dto);
}

function seedBringBill(
  requestId: string,
  sessionId: string,
  restaurantId: string,
  status: ServiceRequestStatus,
  createdAt: string,
) {
  const repos = sharedRepos();
  (repos.serviceRequests as unknown as {
    _seed(r: ServiceRequestDTO): ServiceRequestDTO;
  })._seed(makeBringBill(requestId, sessionId, restaurantId, status, createdAt));
}

function seedBill(dto: SessionBillDTO) {
  const repos = sharedRepos();
  (repos.sessionBills as unknown as {
    _seed(b: SessionBillDTO): SessionBillDTO;
  })._seed(dto);
}

function seedOrder(dto: DineInOrderWithItemsDTO) {
  const repos = sharedRepos();
  (repos.dineInOrders as unknown as {
    _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
  })._seed(dto);
}

function seedZone(zone: DineZoneDTO) {
  (getDineInTableBoardReadRepository() as unknown as {
    _seedZone(z: DineZoneDTO): DineZoneDTO;
  })._seedZone(zone);
}

/** Standard owned billable row: a full BILL_REQUESTED session graph. */
function seedBillable(
  sessionId: string,
  tableId: string,
  billId: string,
  requestId: string,
  status: ServiceRequestStatus,
  sessionCreatedAt: string,
  billRequestedAt: string,
) {
  seedTable(tableId, REST_ID, `T-${tableId}`);
  seedSession(
    makeSession(
      sessionId,
      REST_ID,
      tableId,
      "BILL_REQUESTED",
      sessionCreatedAt,
      billRequestedAt,
    ),
  );
  seedBringBill(requestId, sessionId, REST_ID, status, billRequestedAt);
  seedBill(makeBill(billId, sessionId, REST_ID, billRequestedAt));
}

async function currentBringBillStatus(
  requestId: string,
): Promise<ServiceRequestStatus | null> {
  const request = await sharedRepos().serviceRequests.getById(requestId);
  return request?.status ?? null;
}

async function currentSessionStatus(
  sessionId: string,
): Promise<DiningSessionStatus | null> {
  const session = await sharedRepos().diningSessions.getById(sessionId);
  return session?.status ?? null;
}

describe("Vendor Dine-In bill routes (DINE-OPS4-B1)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    resetDineInState();
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
    app = createApp();
  });

  // ---- mount-level auth ------------------------------------------------

  it("1. no token is rejected at the vendor mount (list + detail + actions)", async () => {
    await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .expect(401);
    await request(app).get(`/api/vendor/dine-in/bills/${BILL_1}`).expect(401);
    await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .expect(401);
    await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .expect(401);
  });

  it("2. CONSUMER role is rejected at the vendor mount (list + detail + actions)", async () => {
    await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
    await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_1}`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
    await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
    await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
  });

  // ---- queue read ------------------------------------------------------

  it("3. invalid restaurant_id is a VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .get("/api/vendor/dine-in/bills?restaurant_id=not-a-uuid")
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("4. authorized owner queue: BILL_REQUESTED + BRING_BILL PENDING/ACK, ordered bill_requested_at ASC then bill.id ASC, table derived, COMPLETED + terminal + cross-restaurant excluded, wire shape exact", async () => {
    // Expected (actionable): BILL_2 (10:00) then BILL_1 (10:01).
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "ACKNOWLEDGED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    seedBillable(SESSION_2, TABLE_2, BILL_2, REQ_BILL_2, "PENDING", "2026-08-24T09:40:00.000Z", "2026-08-24T10:00:00.000Z");
    // Delivered (COMPLETED) bill: NOT actionable, but its session stays
    // BILL_REQUESTED (B1 never advances the session).
    seedBillable(SESSION_3, TABLE_2, BILL_3, REQ_BILL_3, "COMPLETED", "2026-08-24T09:30:00.000Z", "2026-08-24T09:55:00.000Z");
    // Cross-restaurant row (excluded).
    seedTable(TABLE_G, GREEN_BOWL_ID, "G1");
    seedSession(
      makeSession(SESSION_G, GREEN_BOWL_ID, TABLE_G, "BILL_REQUESTED", "2026-08-24T09:00:00.000Z", "2026-08-24T09:05:00.000Z"),
    );
    seedBringBill(REQ_BILL_G, SESSION_G, GREEN_BOWL_ID, "PENDING", "2026-08-24T09:05:00.000Z");
    seedBill(makeBill(BILL_G, SESSION_G, GREEN_BOWL_ID, "2026-08-24T09:05:00.000Z"));

    const res = await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.error).toBeNull();
    const queue = res.body.data as Array<Record<string, unknown>>;

    // Ordering + membership exactly (bill_requested_at ASC, then bill id ASC).
    expect(queue.map((r) => (r.bill as { id: string }).id)).toEqual([
      BILL_2,
      BILL_1,
    ]);
    expect(queue.map((r) => ((r.bring_bill_request as { id: string }).id))).toEqual([
      REQ_BILL_2,
      REQ_BILL_1,
    ]);
    expect(queue.map((r) => ((r.bring_bill_request as { status: string }).status))).toEqual([
      "PENDING",
      "ACKNOWLEDGED",
    ]);

    // Wire row shape (queue): bill totals + session + derived table + request.
    const first = queue[0] as {
      bill: Record<string, unknown>;
      session: Record<string, unknown>;
      table: Record<string, unknown>;
      bring_bill_request: Record<string, unknown>;
    };
    expect(first.bill).toEqual({
      id: BILL_2,
      session_id: SESSION_2,
      restaurant_id: REST_ID,
      food_subtotal: 200,
      packaging_fee: 0,
      gst_food: 10,
      gst_packaging: 0,
      total_amount: 210,
      frozen_at: "2026-08-24T10:00:00.000Z",
    });
    expect(first.session).toEqual({
      id: SESSION_2,
      status: "BILL_REQUESTED",
      bill_requested_at: "2026-08-24T10:00:00.000Z",
      opened_at: "2026-08-24T09:40:00.000Z",
    });
    expect(first.table).toEqual({ id: TABLE_2, label: `T-${TABLE_2}` });
    expect(first.bring_bill_request).toEqual({
      id: REQ_BILL_2,
      status: "PENDING",
    });

    // No forbidden internal/payment/owner identity field anywhere.
    const serialized = JSON.stringify(queue);
    expect(serialized).not.toContain("owner_user_id");
    expect(serialized).not.toContain("requested_by");
    expect(serialized).not.toContain("table_token");
    expect(serialized).not.toContain("payment_");
    expect(serialized).not.toContain("settlement");
    expect(serialized).not.toContain("closed_at");

    const ids = queue.map((r) => (r.bill as { id: string }).id);
    expect(ids).not.toContain(BILL_3);
    expect(ids).not.toContain(BILL_G);
  });

  it("5. queue is ordered by bill id ASC when bill_requested_at ties", async () => {
    seedBillable(SESSION_1, TABLE_1, "aa100000-0000-4000-8000-000000000001", REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:00:00.000Z");
    seedBillable(SESSION_2, TABLE_2, "aa200000-0000-4000-8000-000000000001", REQ_BILL_2, "PENDING", "2026-08-24T09:40:00.000Z", "2026-08-24T10:00:00.000Z");

    const res = await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    const queue = res.body.data as Array<{ bill: { id: string } }>;
    expect(queue.map((r) => r.bill.id)).toEqual([
      "aa100000-0000-4000-8000-000000000001",
      "aa200000-0000-4000-8000-000000000001",
    ]);
  });

  it("6. scoped staff and ADMIN can read the queue; unrelated vendor cannot", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");

    await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);

    sharedUserRoleRepo._seed({
      id: "ur-bill-staff-1",
      user_id: STAFF_ID,
      scope_type: "restaurant",
      scope_id: REST_ID,
      role: "VENDOR_STAFF",
      created_at: "2026-08-24T00:00:00.000Z",
    });
    const staffRes = await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(STAFF_ID, "VENDOR_STAFF"))
      .expect(200);
    expect((staffRes.body.data as Array<{ bill: { id: string } }>).map((r) => r.bill.id)).toEqual([BILL_1]);

    const adminRes = await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(ADMIN_ID, "ADMIN"))
      .expect(200);
    expect((adminRes.body.data as Array<{ bill: { id: string } }>).map((r) => r.bill.id)).toEqual([BILL_1]);
  });

  // ---- bill detail -----------------------------------------------------

  it("7. owned bill detail returns the exact frozen VendorBillDetail wire shape", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    seedZone(makeZone(ZONE_1, REST_ID, "Main Hall"));
    seedOrder(makeOrder("o1", SESSION_1, REST_ID, "SERVED", "2026-08-24T10:00:00.000Z"));
    // CANCELLED order is excluded from the bill snapshot (listForBill semantics).
    seedOrder(makeOrder("o2", SESSION_1, REST_ID, "CANCELLED", "2026-08-24T10:00:30.000Z"));

    const res = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_1}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);

    expect(res.body.success).toBe(true);
    const detail = res.body.data as Record<string, unknown>;
    expect(detail.bill).toEqual({
      id: BILL_1,
      session_id: SESSION_1,
      restaurant_id: REST_ID,
      food_subtotal: 200,
      packaging_fee: 0,
      gst_food: 10,
      gst_packaging: 0,
      total_amount: 210,
      frozen_at: "2026-08-24T10:01:00.000Z",
    });
    expect(detail.session).toEqual({
      id: SESSION_1,
      status: "BILL_REQUESTED",
      bill_requested_at: "2026-08-24T10:01:00.000Z",
      opened_at: "2026-08-24T09:50:00.000Z",
    });
    expect(detail.table).toEqual({ id: TABLE_1, label: `T-${TABLE_1}` });
    expect(detail.zone).toEqual({ id: ZONE_1, name: "Main Hall" });
    expect(detail.bring_bill_request).toEqual({
      id: REQ_BILL_1,
      status: "PENDING",
      acknowledged_at: null,
      completed_at: null,
    });
    const orders = detail.orders as Array<Record<string, unknown>>;
    expect(orders.map((o) => o.id)).toEqual(["o1"]);
    expect((orders[0] as { items: Array<{ name: string; quantity: number; item_subtotal: number }> }).items).toEqual([
      { name: "Paneer Tikka", quantity: 2, item_subtotal: 200 },
    ]);

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("owner_user_id");
    expect(serialized).not.toContain("requested_by");
    expect(serialized).not.toContain("table_token");
    expect(serialized).not.toContain("payment_");
    expect(serialized).not.toContain("settlement");
  });

  it("8. a delivered bill's detail stays readable with a COMPLETED request", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "COMPLETED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    seedOrder(makeOrder("o1", SESSION_1, REST_ID, "SERVED", "2026-08-24T10:00:00.000Z"));

    const res = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_1}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    const detail = res.body.data as { bring_bill_request: Record<string, unknown>; session: Record<string, unknown> };
    expect(detail.session.status).toBe("BILL_REQUESTED");
    expect(detail.bring_bill_request).toEqual({
      id: REQ_BILL_1,
      status: "COMPLETED",
      acknowledged_at: null,
      completed_at: null,
    });
  });

  // ---- detail authorization / guards ----------------------------------

  it("9. cross-restaurant detail is FORBIDDEN 403 with zero existence/state leak", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_1}`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("10. non-UUID billId is a VALIDATION_ERROR 400 (detail + actions)", async () => {
    const detail = await request(app)
      .get("/api/vendor/dine-in/bills/not-a-uuid")
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
    expect(detail.body.error.code).toBe("VALIDATION_ERROR");
    const ack = await request(app)
      .post("/api/vendor/dine-in/bills/not-a-uuid/acknowledge")
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
    expect(ack.body.error.code).toBe("VALIDATION_ERROR");
    const deliver = await request(app)
      .post("/api/vendor/dine-in/bills/not-a-uuid/deliver")
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
    expect(deliver.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("11. unknown bill -> BILL_NOT_FOUND 404 (detail + actions)", async () => {
    const detail = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_UNKNOWN}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(404);
    expect(detail.body.error.code).toBe("BILL_NOT_FOUND");
    const ack = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_UNKNOWN}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(404);
    expect(ack.body.error.code).toBe("BILL_NOT_FOUND");
    const deliver = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_UNKNOWN}/deliver`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(404);
    expect(deliver.body.error.code).toBe("BILL_NOT_FOUND");
  });

  // ---- acknowledge -----------------------------------------------------

  it("12. owner acknowledges PENDING -> ACKNOWLEDGED with server-authoritative audit", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(res.body.data.request.id).toBe(REQ_BILL_1);
    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
    expect(res.body.data.request.acknowledged_by).toBe(OWNER_ID);
    expect(typeof res.body.data.request.acknowledged_at).toBe("string");
    // No session/bill mutation on acknowledge.
    expect(await currentSessionStatus(SESSION_1)).toBe("BILL_REQUESTED");
  });

  it("13. acknowledge is idempotent on an ACKNOWLEDGED bill (frozen retry)", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "ACKNOWLEDGED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
  });

  it("14. ack body fields are NOT authoritative (server sets audit)", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({
        acknowledged_by: "attacker-id",
        acknowledged_at: "2099-01-01T00:00:00.000Z",
        status: "COMPLETED",
        restaurant_id: GREEN_BOWL_ID,
      })
      .expect(200);
    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
    expect(res.body.data.request.acknowledged_by).toBe(OWNER_ID);
    expect(res.body.data.request.acknowledged_at).not.toBe("2099-01-01T00:00:00.000Z");
  });

  // ---- deliver ---------------------------------------------------------

  it("15. owner delivers ACKNOWLEDGED -> COMPLETED; bill leaves the queue; detail stays readable; totals/session unchanged", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "ACKNOWLEDGED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    seedOrder(makeOrder("o1", SESSION_1, REST_ID, "SERVED", "2026-08-24T10:00:00.000Z"));

    const delivered = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(delivered.body.data.request.id).toBe(REQ_BILL_1);
    expect(delivered.body.data.request.status).toBe("COMPLETED");
    expect(delivered.body.data.request.completed_by).toBe(OWNER_ID);
    expect(typeof delivered.body.data.request.completed_at).toBe("string");

    // No session/bill/payment mutation.
    expect(await currentSessionStatus(SESSION_1)).toBe("BILL_REQUESTED");

    // Leaves the actionable queue.
    const queueRes = await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect((queueRes.body.data as Array<{ bill: { id: string } }>).map((r) => r.bill.id)).toEqual([]);

    // Detail stays readable with the COMPLETED artifact.
    const detailRes = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_1}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    const detail = detailRes.body.data as {
      bill: { total_amount: number };
      bring_bill_request: { status: string; completed_at: string | null };
      session: { status: string };
    };
    expect(detail.bill.total_amount).toBe(210);
    expect(detail.session.status).toBe("BILL_REQUESTED");
    expect(detail.bring_bill_request.status).toBe("COMPLETED");
    expect(typeof detail.bring_bill_request.completed_at).toBe("string");
  });

  it("16. deliver is idempotent on an already-COMPLETED bill (frozen retry)", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "COMPLETED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(res.body.data.request.status).toBe("COMPLETED");
  });

  it("17. a PENDING bill cannot be delivered directly (409, no silent auto-ack)", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(res.body.error.code).toBe("INVALID_SERVICE_REQUEST_TRANSITION");
    expect(await currentBringBillStatus(REQ_BILL_1)).toBe("PENDING");
  });

  it("18. owner runs the full acknowledge -> deliver lifecycle; delivered bill is gone from the queue", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");

    const ack = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(ack.body.data.request.status).toBe("ACKNOWLEDGED");

    const done = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(done.body.data.request.status).toBe("COMPLETED");
    expect(await currentBringBillStatus(REQ_BILL_1)).toBe("COMPLETED");

    const queueRes = await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect((queueRes.body.data as Array<{ bill: { id: string } }>).map((r) => r.bill.id)).toEqual([]);
  });

  // ---- mutation authorization + guards ---------------------------------

  it("19. cross-restaurant bill mutation is ZERO (403 before any service call)", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");

    const ack = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(ack.body.error.code).toBe("FORBIDDEN");
    expect(await currentBringBillStatus(REQ_BILL_1)).toBe("PENDING");

    const deliver = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(deliver.body.error.code).toBe("FORBIDDEN");
    expect(await currentBringBillStatus(REQ_BILL_1)).toBe("PENDING");
    expect(await currentSessionStatus(SESSION_1)).toBe("BILL_REQUESTED");
  });

  it("20. client cannot spoof ownership via body/query restaurant_id", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(
        `/api/vendor/dine-in/bills/${BILL_1}/acknowledge?restaurant_id=${GREEN_BOWL_ID}`,
      )
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .send({ restaurant_id: GREEN_BOWL_ID })
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(await currentBringBillStatus(REQ_BILL_1)).toBe("PENDING");
  });

  it("21. foreign bill under a corrupted BILL_REQUESTED session is FORBIDDEN, never a 500 invariant leak", async () => {
    // REST-owned bill whose BILL_REQUESTED session has NO BRING_BILL artifact.
    seedTable(TABLE_1, REST_ID, "T1");
    seedSession(
      makeSession(SESSION_1, REST_ID, TABLE_1, "BILL_REQUESTED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
    );
    seedBill(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));

    // Foreign owner -> plain 403 before the invariant could ever run.
    const detail = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_1}`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(detail.body.error.code).toBe("FORBIDDEN");
    expect(detail.body.error.code).not.toBe("BILL_INVARIANT_VIOLATION");

    const ack = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(ack.body.error.code).toBe("FORBIDDEN");
    expect(ack.body.error.code).not.toBe("BILL_INVARIANT_VIOLATION");

    const deliver = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(deliver.body.error.code).toBe("FORBIDDEN");
    expect(deliver.body.error.code).not.toBe("BILL_INVARIANT_VIOLATION");
  });

  it("22. owned bill under a BILL_REQUESTED session with NONE/MULTIPLE BRING_BILL is a 500 BILL_INVARIANT_VIOLATION (post-auth)", async () => {
    // NONE.
    seedTable(TABLE_1, REST_ID, "T1");
    seedSession(
      makeSession(SESSION_1, REST_ID, TABLE_1, "BILL_REQUESTED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
    );
    seedBill(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));
    seedOrder(makeOrder("o1", SESSION_1, REST_ID, "SERVED", "2026-08-24T10:00:00.000Z"));

    const noneDetail = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_1}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(500);
    expect(noneDetail.body.error.code).toBe("BILL_INVARIANT_VIOLATION");
    const noneAck = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(500);
    expect(noneAck.body.error.code).toBe("BILL_INVARIANT_VIOLATION");

    // MULTIPLE (two BRING_BILL artifacts on the same session).
    seedTable(TABLE_2, REST_ID, "T2");
    seedSession(
      makeSession(SESSION_2, REST_ID, TABLE_2, "BILL_REQUESTED", "2026-08-24T09:40:00.000Z", "2026-08-24T10:00:00.000Z"),
    );
    seedBill(makeBill(BILL_2, SESSION_2, REST_ID, "2026-08-24T10:00:00.000Z"));
    seedBringBill(REQ_BILL_1, SESSION_2, REST_ID, "PENDING", "2026-08-24T10:00:00.000Z");
    seedBringBill(REQ_BILL_2, SESSION_2, REST_ID, "ACKNOWLEDGED", "2026-08-24T10:00:01.000Z");

    const multiDetail = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_2}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(500);
    expect(multiDetail.body.error.code).toBe("BILL_INVARIANT_VIOLATION");
    const multiDeliver = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_2}/deliver`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(500);
    expect(multiDeliver.body.error.code).toBe("BILL_INVARIANT_VIOLATION");
    expect(await currentBringBillStatus(REQ_BILL_2)).toBe("ACKNOWLEDGED");
  });

  it("23. ADMIN bypasses restaurant ownership (platform oversight)", async () => {
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
    const ack = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(ADMIN_ID, "ADMIN"))
      .expect(200);
    expect(ack.body.data.request.status).toBe("ACKNOWLEDGED");

    const done = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(ADMIN_ID, "ADMIN"))
      .expect(200);
    expect(done.body.data.request.status).toBe("COMPLETED");
  });

  it("24. ack/deliver on a bill whose session left BILL_REQUESTED is a 409 (route boundary), zero mutation", async () => {
    // A frozen bill whose session moved on (PAYMENT_PENDING). The bill is still
    // readable by detail, but the action boundary is the route's own 409.
    seedTable(TABLE_1, REST_ID, "T1");
    seedSession(
      makeSession(SESSION_1, REST_ID, TABLE_1, "PAYMENT_PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
    );
    seedBringBill(REQ_BILL_1, SESSION_1, REST_ID, "ACKNOWLEDGED", "2026-08-24T10:01:00.000Z");
    seedBill(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));

    const ack = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(ack.body.error.code).toBe("INVALID_SERVICE_REQUEST_TRANSITION");

    const deliver = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(deliver.body.error.code).toBe("INVALID_SERVICE_REQUEST_TRANSITION");

    // Route boundary fired BEFORE any service call: the ACKNOWLEDGED artifact
    // and the PAYMENT_PENDING session were not mutated.
    expect(await currentBringBillStatus(REQ_BILL_1)).toBe("ACKNOWLEDGED");
    expect(await currentSessionStatus(SESSION_1)).toBe("PAYMENT_PENDING");

    // The bill remains readable via detail (read is never blocked by the action
    // boundary), but is gone from the actionable queue.
    const detail = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_1}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(detail.body.data.session.status).toBe("PAYMENT_PENDING");

    const queueRes = await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect((queueRes.body.data as Array<{ bill: { id: string } }>).map((r) => r.bill.id)).toEqual([]);
  });

  it("25. ack after a bill was already delivered (COMPLETED artifact) is a 409", async () => {
    // Deliver leaves the session BILL_REQUESTED but the artifact is terminal
    // COMPLETED; the frozen service rejects ack on COMPLETED with 409.
    seedBillable(SESSION_1, TABLE_1, BILL_1, REQ_BILL_1, "COMPLETED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");

    const ack = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(ack.body.error.code).toBe("INVALID_SERVICE_REQUEST_TRANSITION");
    expect(await currentBringBillStatus(REQ_BILL_1)).toBe("COMPLETED");

    // Deliver itself remains an idempotent 200 (frozen retry).
    const redeliver = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(redeliver.body.data.request.status).toBe("COMPLETED");
  });

  it("26. FOREIGN MULTIPLE PRECEDENCE: a foreign bill whose BILL_REQUESTED session has MULTIPLE BRING_BILL artifacts is FORBIDDEN (403), never a 500 invariant leak, on detail AND action routes", async () => {
    // REST-owned bill whose BILL_REQUESTED session carries MULTIPLE BRING_BILL
    // artifacts (PENDING + ACKNOWLEDGED). Authorization must be evaluated on the
    // invariant-free access context BEFORE the MULTIPLE invariant read, so a
    // foreign owner gets 403 FORBIDDEN -- never 500 BILL_INVARIANT_VIOLATION.
    seedTable(TABLE_1, REST_ID, "T1");
    seedSession(
      makeSession(SESSION_1, REST_ID, TABLE_1, "BILL_REQUESTED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
    );
    seedBill(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));
    seedBringBill(REQ_BILL_1, SESSION_1, REST_ID, "PENDING", "2026-08-24T10:01:00.000Z");
    seedBringBill(REQ_BILL_2, SESSION_1, REST_ID, "ACKNOWLEDGED", "2026-08-24T10:01:01.000Z");

    // Foreign owner (Green Bowl) -> detail is 403 before the MULTIPLE invariant.
    const detail = await request(app)
      .get(`/api/vendor/dine-in/bills/${BILL_1}`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(detail.body.error.code).toBe("FORBIDDEN");
    expect(detail.body.error.code).not.toBe("BILL_INVARIANT_VIOLATION");

    // Action routes share the same precedence: 403, not 500.
    const ack = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/acknowledge`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(ack.body.error.code).toBe("FORBIDDEN");
    expect(ack.body.error.code).not.toBe("BILL_INVARIANT_VIOLATION");

    const deliver = await request(app)
      .post(`/api/vendor/dine-in/bills/${BILL_1}/deliver`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(deliver.body.error.code).toBe("FORBIDDEN");
    expect(deliver.body.error.code).not.toBe("BILL_INVARIANT_VIOLATION");

    // Zero mutation: the foreign 403 must not touch either BRING_BILL artifact.
    expect(await currentBringBillStatus(REQ_BILL_1)).toBe("PENDING");
    expect(await currentBringBillStatus(REQ_BILL_2)).toBe("ACKNOWLEDGED");
  });

  it("27. CLOSED QUEUE EXCLUSION: a CLOSED session's frozen bill stays out of the owned queue even with an actionable BRING_BILL artifact", async () => {
    // REST-owned frozen bill/session that already reached CLOSED. The associated
    // BRING_BILL artifact (PENDING) must NOT be able to pull the bill back into
    // the vendor queue -- membership requires session.status === "BILL_REQUESTED".
    seedTable(TABLE_1, REST_ID, "T1");
    seedSession(
      makeSession(SESSION_1, REST_ID, TABLE_1, "CLOSED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
    );
    seedBill(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));
    seedBringBill(REQ_BILL_1, SESSION_1, REST_ID, "PENDING", "2026-08-24T10:01:00.000Z");

    // Control row that IS actionable, to prove the queue itself is live and only
    // the CLOSED bill is excluded.
    seedBillable(SESSION_2, TABLE_2, BILL_2, REQ_BILL_2, "PENDING", "2026-08-24T09:40:00.000Z", "2026-08-24T10:00:00.000Z");

    const res = await request(app)
      .get(`/api/vendor/dine-in/bills?restaurant_id=${REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    const queue = res.body.data as Array<{ bill: { id: string } }>;

    // The live control row is present; the CLOSED bill is absent.
    expect(queue.map((r) => r.bill.id)).toEqual([BILL_2]);
    expect(queue.map((r) => r.bill.id)).not.toContain(BILL_1);
  });
});
