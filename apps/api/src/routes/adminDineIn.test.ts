import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  DiningSessionStatus,
  DineInOrderStatus,
  ServiceRequestStatus,
  ServiceRequestType,
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

// ============================================================
// ADMIN-OPS1-A2 admin Dine-In read-only routes:
//   GET /api/v1/admin/dine-in/overview
//   GET /api/v1/admin/dine-in/sessions
//   GET /api/v1/admin/dine-in/sessions/:sessionId
//
// Live scope is OPEN | ACTIVE | BILL_REQUESTED | PAYMENT_PENDING (CLOSED
// excluded everywhere; known CLOSED/unknown detail -> 404). Every response is
// an explicit DTO mapping — no owner/requester/actor identity, no table_token,
// no payment/settlement fields — and bill status derives ONLY from the
// BRING_BILL lifecycle (NONE/REQUESTED/ACKNOWLEDGED/DELIVERED). No fake
// PAID/SETTLED/PAYMENT_SUCCESS state, PAYMENT_PENDING only as a session
// status. Memory fixtures seed the shared in-memory Dine-In universe.
// ============================================================

// Catalog seed restaurants (apps/api/src/seed/catalogData.ts).
const REST_A = "a0000000-0000-4000-8000-000000000001"; // Biryani House
const REST_B = "a0000000-0000-4000-8000-000000000002"; // Green Bowl
const REST_A_NAME = "Biryani House";
const REST_B_NAME = "Green Bowl";

const CONSUMER_ID = "u00000000-0000-4000-8000-000000000001";

// Tables.
const T_A1 = "10000000-0000-4000-8000-000000000001"; // Biryani, zone Z_A1, T1
const T_A2 = "10000000-0000-4000-8000-000000000002"; // Biryani, no zone, T2
const T_A3 = "10000000-0000-4000-8000-000000000003"; // Biryani, no zone, T3
const T_B1 = "20000000-0000-4000-8000-000000000001"; // Green Bowl, zone Z_B1, GT1

// Zones.
const Z_A1 = "40000000-0000-4000-8000-000000000001"; // Main Hall (Biryani)
const Z_B1 = "40000000-0000-4000-8000-000000000002"; // Garden (Green Bowl)

// Sessions.
const S_A1 = "50000000-0000-4000-8000-000000000001"; // OPEN (Biryani)
const S_A2 = "60000000-0000-4000-8000-000000000001"; // BILL_REQUESTED (Biryani)
const S_A3 = "70000000-0000-4000-8000-000000000001"; // ACTIVE (Biryani)
const S_B1 = "80000000-0000-4000-8000-000000000001"; // PAYMENT_PENDING (Green Bowl)

// Bills.
const BILL_A2 = "a1000000-0000-4000-8000-000000000001";
const BILL_B1 = "a2000000-0000-4000-8000-000000000001";

// Requests.
const R_A1_WATER = "b1000000-0000-4000-8000-000000000001";
const R_A2_BILL = "b2000000-0000-4000-8000-000000000001";
const R_A3_CUTLERY = "b3000000-0000-4000-8000-000000000001";
const R_B1_BILL = "b4000000-0000-4000-8000-000000000001";

const KNOWN_BILL_TOTALS = {
  food_subtotal: 400,
  packaging_fee: 20,
  gst_food: 42,
  gst_packaging: 2,
  total_amount: 464,
};

// Every response of the three endpoints must never contain these tokens.
const FORBIDDEN_TOKENS = [
  "table_token",
  "owner_user_id",
  "requested_by",
  "requested_by_user_id",
  "actor_user_id",
  "payment_id",
  "payment_order_id",
  "razorpay",
  "settlement_",
  "access_token",
  "refresh_token",
];

// Deep-negative scan helper: serializes the ENTIRE response body and asserts
// no sensitive token or fabricated payment/terminal state appears anywhere.
function assertResponseClean(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  for (const token of FORBIDDEN_TOKENS) {
    expect(serialized, `forbidden token: ${token}`).not.toContain(token);
  }
  for (const fake of ['"PAID"', '"SETTLED"', '"PAYMENT_SUCCESS"', '"CLOSED"']) {
    expect(serialized, `fabricated state: ${fake}`).not.toContain(fake);
  }
}

function authHeaders(userId?: string, role?: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId ?? "00000000-0000-4000-8000-0000000000aa",
      phone: "+919876543210",
      role: role ?? "ADMIN",
      device_fingerprint: "fp_test_device_abc1234",
    })}`,
  };
}

function makeTable(
  id: string,
  restaurantId: string,
  label: string,
  zoneId: string | null = null,
): RestaurantTableDTO {
  return {
    id,
    restaurant_id: restaurantId,
    zone_id: zoneId,
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

function makeSession(params: {
  id: string;
  restaurantId: string;
  tableId: string;
  status: DiningSessionStatus;
  openedAt: string;
  updatedAt?: string;
  billRequestedAt?: string | null;
  paymentPendingAt?: string | null;
}): DiningSessionDTO {
  return {
    id: params.id,
    restaurant_id: params.restaurantId,
    table_id: params.tableId,
    owner_user_id: CONSUMER_ID,
    status: params.status,
    bill_requested_at: params.billRequestedAt ?? null,
    payment_pending_at: params.paymentPendingAt ?? null,
    closed_at: params.status === "CLOSED" ? params.openedAt : null,
    created_at: params.openedAt,
    updated_at: params.updatedAt ?? params.openedAt,
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
    ...KNOWN_BILL_TOTALS,
    frozen_at: frozenAt,
    created_at: frozenAt,
  };
}

function makeRequest(params: {
  id: string;
  sessionId: string;
  restaurantId: string;
  requestType: ServiceRequestType;
  status: ServiceRequestStatus;
  createdAt: string;
  note?: string | null;
  acknowledgedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
}): ServiceRequestDTO {
  return {
    id: params.id,
    session_id: params.sessionId,
    restaurant_id: params.restaurantId,
    requested_by: CONSUMER_ID,
    request_type: params.requestType,
    status: params.status,
    note: params.note ?? null,
    acknowledged_by: params.acknowledgedAt ? "90000000-0000-4000-a000-000000000099" : null,
    acknowledged_at: params.acknowledgedAt ?? null,
    completed_by: params.completedAt ? "90000000-0000-4000-a000-000000000099" : null,
    completed_at: params.completedAt ?? null,
    cancelled_by: params.cancelledAt ? CONSUMER_ID : null,
    cancelled_at: params.cancelledAt ?? null,
    created_at: params.createdAt,
    updated_at: params.completedAt ?? params.acknowledgedAt ?? params.createdAt,
  };
}

function makeOrder(params: {
  id: string;
  sessionId: string;
  restaurantId: string;
  status: DineInOrderStatus;
  createdAt: string;
  items?: DineInOrderWithItemsDTO["items"];
}): DineInOrderWithItemsDTO {
  const items =
    params.items ??
    [
      {
        id: `item-${params.id}`,
        dine_in_order_id: params.id,
        restaurant_id: params.restaurantId,
        menu_item_id: "menu-1",
        name: "Paneer Tikka",
        base_price: 100,
        quantity: 2,
        customizations: [],
        customization_total: 0,
        item_subtotal: 200,
        created_at: params.createdAt,
      },
    ];
  return {
    id: params.id,
    session_id: params.sessionId,
    restaurant_id: params.restaurantId,
    placed_by: CONSUMER_ID,
    status: params.status,
    total_amount: items.reduce((sum, item) => sum + item.item_subtotal, 0),
    notes: null,
    served_at: params.status === "SERVED" ? params.createdAt : null,
    cancelled_at: params.status === "CANCELLED" ? params.createdAt : null,
    cancelled_by: params.status === "CANCELLED" ? CONSUMER_ID : null,
    created_at: params.createdAt,
    updated_at: params.createdAt,
    items,
  };
}

function sharedRepos(): DineInTransactionRepos {
  return (getDineInTransactionPort() as unknown as {
    repos: DineInTransactionRepos;
  }).repos;
}

function seedTable(
  tableId: string,
  restaurantId: string,
  label: string,
  zoneId: string | null = null,
): void {
  const repos = sharedRepos();
  (repos.restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  })._seed(makeTable(tableId, restaurantId, label, zoneId));
}

function seedSession(dto: DiningSessionDTO): void {
  const repos = sharedRepos();
  (repos.diningSessions as unknown as {
    _seed(s: DiningSessionDTO): DiningSessionDTO;
  })._seed(dto);
}

function seedRequest(dto: ServiceRequestDTO): void {
  const repos = sharedRepos();
  (repos.serviceRequests as unknown as {
    _seed(r: ServiceRequestDTO): ServiceRequestDTO;
  })._seed(dto);
}

function seedBill(dto: SessionBillDTO): void {
  const repos = sharedRepos();
  (repos.sessionBills as unknown as {
    _seed(b: SessionBillDTO): SessionBillDTO;
  })._seed(dto);
}

function seedOrder(dto: DineInOrderWithItemsDTO): void {
  const repos = sharedRepos();
  (repos.dineInOrders as unknown as {
    _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
  })._seed(dto);
}

function seedZone(zone: DineZoneDTO): void {
  (getDineInTableBoardReadRepository() as unknown as {
    _seedZone(z: DineZoneDTO): DineZoneDTO;
  })._seedZone(zone);
}

/** Biryani: OPEN (water pending), BILL_REQUESTED (bill requested + frozen),
 *  ACTIVE (cutlery acknowledged). Green Bowl: PAYMENT_PENDING (bill delivered
 *  + frozen, 2 orders). CLOSED sessions are seeded only by CLOSED tests. */
function seedLiveFixture(): void {
  seedTable(T_A1, REST_A, "T1", Z_A1);
  seedTable(T_A2, REST_A, "T2");
  seedTable(T_A3, REST_A, "T3");
  seedTable(T_B1, REST_B, "GT1", Z_B1);
  seedZone(makeZone(Z_A1, REST_A, "Main Hall"));
  seedZone(makeZone(Z_B1, REST_B, "Garden"));

  seedSession(
    makeSession({
      id: S_A1,
      restaurantId: REST_A,
      tableId: T_A1,
      status: "OPEN",
      openedAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:05:00.000Z",
    }),
  );
  seedSession(
    makeSession({
      id: S_A2,
      restaurantId: REST_A,
      tableId: T_A2,
      status: "BILL_REQUESTED",
      openedAt: "2026-08-24T09:10:00.000Z",
      updatedAt: "2026-08-24T09:16:00.000Z",
      billRequestedAt: "2026-08-24T09:16:00.000Z",
    }),
  );
  seedSession(
    makeSession({
      id: S_A3,
      restaurantId: REST_A,
      tableId: T_A3,
      status: "ACTIVE",
      openedAt: "2026-08-24T08:30:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    }),
  );
  seedSession(
    makeSession({
      id: S_B1,
      restaurantId: REST_B,
      tableId: T_B1,
      status: "PAYMENT_PENDING",
      openedAt: "2026-08-24T09:20:00.000Z",
      updatedAt: "2026-08-24T09:30:00.000Z",
      billRequestedAt: "2026-08-24T09:25:00.000Z",
      paymentPendingAt: "2026-08-24T09:29:00.000Z",
    }),
  );

  seedRequest(
    makeRequest({
      id: R_A1_WATER,
      sessionId: S_A1,
      restaurantId: REST_A,
      requestType: "WATER",
      status: "PENDING",
      createdAt: "2026-08-24T09:01:00.000Z",
    }),
  );
  seedRequest(
    makeRequest({
      id: R_A2_BILL,
      sessionId: S_A2,
      restaurantId: REST_A,
      requestType: "BRING_BILL",
      status: "PENDING",
      createdAt: "2026-08-24T09:16:00.000Z",
    }),
  );
  seedRequest(
    makeRequest({
      id: R_A3_CUTLERY,
      sessionId: S_A3,
      restaurantId: REST_A,
      requestType: "CUTLERY",
      status: "ACKNOWLEDGED",
      createdAt: "2026-08-24T08:50:00.000Z",
      acknowledgedAt: "2026-08-24T08:55:00.000Z",
    }),
  );
  seedRequest(
    makeRequest({
      id: R_B1_BILL,
      sessionId: S_B1,
      restaurantId: REST_B,
      requestType: "BRING_BILL",
      status: "COMPLETED",
      createdAt: "2026-08-24T09:25:00.000Z",
      acknowledgedAt: "2026-08-24T09:26:00.000Z",
      completedAt: "2026-08-24T09:27:00.000Z",
    }),
  );

  seedBill(makeBill(BILL_A2, S_A2, REST_A, "2026-08-24T09:16:00.000Z"));
  seedBill(makeBill(BILL_B1, S_B1, REST_B, "2026-08-24T09:27:00.000Z"));
  seedOrder(
    makeOrder({
      id: "o-a1-1",
      sessionId: S_A1,
      restaurantId: REST_A,
      status: "SERVED",
      createdAt: "2026-08-24T09:02:00.000Z",
    }),
  );
  seedOrder(
    makeOrder({
      id: "o-b1-1",
      sessionId: S_B1,
      restaurantId: REST_B,
      status: "SERVED",
      createdAt: "2026-08-24T09:22:00.000Z",
    }),
  );
  seedOrder(
    makeOrder({
      id: "o-b1-2",
      sessionId: S_B1,
      restaurantId: REST_B,
      status: "CANCELLED",
      createdAt: "2026-08-24T09:23:00.000Z",
    }),
  );
}

/** Two fresh Biryani OPEN sessions (no other fixture) sharing the exact same
 *  opened_at, on their own tables, for the deterministic tie-break proof. */
function seedTieBreakFixture(): void {
  const T_TIE_1 = "10000000-0000-4000-8000-0000000000a1";
  const T_TIE_2 = "10000000-0000-4000-8000-0000000000a2";
  seedTable(T_TIE_1, REST_A, "TA");
  seedTable(T_TIE_2, REST_A, "TB");
  seedSession(
    makeSession({
      id: "a1000000-0000-4000-8000-0000000000a5",
      restaurantId: REST_A,
      tableId: T_TIE_1,
      status: "OPEN",
      openedAt: "2026-08-24T10:00:00.000Z",
    }),
  );
  seedSession(
    makeSession({
      id: "a1000000-0000-4000-8000-0000000000a1",
      restaurantId: REST_A,
      tableId: T_TIE_2,
      status: "OPEN",
      openedAt: "2026-08-24T10:00:00.000Z",
    }),
  );
}

/** Rich PAYMENT_PENDING session graph for the detail endpoint. */
function seedDetailFixture(): void {
  seedTable(T_A1, REST_A, "T1", Z_A1);
  seedZone(makeZone(Z_A1, REST_A, "Main Hall"));
  seedSession(
    makeSession({
      id: S_B1,
      restaurantId: REST_A,
      tableId: T_A1,
      status: "PAYMENT_PENDING",
      openedAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:15:00.000Z",
      billRequestedAt: "2026-08-24T09:07:00.000Z",
      paymentPendingAt: "2026-08-24T09:10:00.000Z",
    }),
  );
  seedBill(makeBill(BILL_B1, S_B1, REST_A, "2026-08-24T09:07:00.000Z"));
  seedOrder(
    makeOrder({
      id: "o-d1",
      sessionId: S_B1,
      restaurantId: REST_A,
      status: "SERVED",
      createdAt: "2026-08-24T09:01:00.000Z",
      items: [
        {
          id: "it-1",
          dine_in_order_id: "o-d1",
          restaurant_id: REST_A,
          menu_item_id: "menu-1",
          name: "Paneer Tikka",
          base_price: 100,
          quantity: 2,
          customizations: [],
          customization_total: 0,
          item_subtotal: 200,
          created_at: "2026-08-24T09:01:00.000Z",
        },
        {
          id: "it-2",
          dine_in_order_id: "o-d1",
          restaurant_id: REST_A,
          menu_item_id: "menu-2",
          name: "Butter Naan",
          base_price: 30,
          quantity: 3,
          customizations: [],
          customization_total: 0,
          item_subtotal: 90,
          created_at: "2026-08-24T09:01:00.000Z",
        },
      ],
    }),
  );
  seedOrder(
    makeOrder({
      id: "o-d2",
      sessionId: S_B1,
      restaurantId: REST_A,
      status: "CANCELLED",
      createdAt: "2026-08-24T09:03:00.000Z",
    }),
  );
  seedRequest(
    makeRequest({
      id: "r-d-water",
      sessionId: S_B1,
      restaurantId: REST_A,
      requestType: "WATER",
      status: "COMPLETED",
      createdAt: "2026-08-24T09:02:00.000Z",
      acknowledgedAt: "2026-08-24T09:03:00.000Z",
      completedAt: "2026-08-24T09:04:00.000Z",
    }),
  );
  seedRequest(
    makeRequest({
      id: "r-d-cutlery",
      sessionId: S_B1,
      restaurantId: REST_A,
      requestType: "CUTLERY",
      status: "ACKNOWLEDGED",
      createdAt: "2026-08-24T09:04:00.000Z",
      acknowledgedAt: "2026-08-24T09:05:00.000Z",
    }),
  );
  seedRequest(
    makeRequest({
      id: "r-d-tissue",
      sessionId: S_B1,
      restaurantId: REST_A,
      requestType: "TISSUE",
      status: "CANCELLED",
      createdAt: "2026-08-24T09:05:00.000Z",
      cancelledAt: "2026-08-24T09:06:00.000Z",
    }),
  );
  seedRequest(
    makeRequest({
      id: R_B1_BILL,
      sessionId: S_B1,
      restaurantId: REST_A,
      requestType: "BRING_BILL",
      status: "COMPLETED",
      createdAt: "2026-08-24T09:07:00.000Z",
      acknowledgedAt: "2026-08-24T09:08:00.000Z",
      completedAt: "2026-08-24T09:09:00.000Z",
    }),
  );
}

/** Minimal single-session detail fixture for bill-state lifecycle tests. */
function seedBillStateFixture(params: {
  sessionId: string;
  tableId: string;
  status: DiningSessionStatus;
  openedAt: string;
  billRequestedAt?: string | null;
  paymentPendingAt?: string | null;
  bringBill?: {
    id: string;
    status: ServiceRequestStatus;
    createdAt: string;
    acknowledgedAt?: string | null;
    completedAt?: string | null;
  };
  withBill?: boolean;
}): void {
  seedTable(params.tableId, REST_A, `T-${params.tableId}`);
  seedSession(
    makeSession({
      id: params.sessionId,
      restaurantId: REST_A,
      tableId: params.tableId,
      status: params.status,
      openedAt: params.openedAt,
      updatedAt: params.openedAt,
      billRequestedAt: params.billRequestedAt ?? null,
      paymentPendingAt: params.paymentPendingAt ?? null,
    }),
  );
  if (params.bringBill) {
    seedRequest(
      makeRequest({
        id: params.bringBill.id,
        sessionId: params.sessionId,
        restaurantId: REST_A,
        requestType: "BRING_BILL",
        status: params.bringBill.status,
        createdAt: params.bringBill.createdAt,
        acknowledgedAt: params.bringBill.acknowledgedAt ?? null,
        completedAt: params.bringBill.completedAt ?? null,
      }),
    );
  }
  if (params.withBill) {
    seedBill(makeBill(`bill-${params.sessionId}`, params.sessionId, REST_A, params.openedAt));
  }
}

const OVERVIEW_URL = "/api/v1/admin/dine-in/overview";
const SESSIONS_URL = "/api/v1/admin/dine-in/sessions";

describe("Admin Dine-In read-only routes (ADMIN-OPS1-A2)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    resetDineInState();
    app = createApp();
  });

  // ---- auth matrix ------------------------------------------------------

  it("1. unauthenticated -> 401 on all three endpoints", async () => {
    await request(app).get(OVERVIEW_URL).expect(401);
    await request(app).get(SESSIONS_URL).expect(401);
    await request(app).get(`${SESSIONS_URL}/${S_A1}`).expect(401);
  });

  it("2. CONSUMER / VENDOR_OWNER / VENDOR_STAFF -> 403 on all three endpoints", async () => {
    for (const role of ["CONSUMER", "VENDOR_OWNER", "VENDOR_STAFF"]) {
      const headers = authHeaders(undefined, role);
      const overview = await request(app).get(OVERVIEW_URL).set(headers).expect(403);
      expect(overview.body.error.code).toBe("FORBIDDEN");
      expect(overview.body.error.message).toBe(
        `Role '${role}' is not authorized for this operation`,
      );
      await request(app).get(SESSIONS_URL).set(headers).expect(403);
      await request(app).get(`${SESSIONS_URL}/${S_A1}`).set(headers).expect(403);
    }
  });

  it("3. ADMIN / SUPER_ADMIN / OPS_AGENT -> 200 on all three endpoints", async () => {
    seedLiveFixture();
    for (const role of ["ADMIN", "SUPER_ADMIN", "OPS_AGENT"]) {
      const headers = authHeaders(undefined, role);
      const overview = await request(app).get(OVERVIEW_URL).set(headers).expect(200);
      expect(overview.body.success).toBe(true);
      expect(overview.body.data.totals.active_sessions).toBe(4);
      const list = await request(app)
        .get(`${SESSIONS_URL}?page=1&limit=2`)
        .set(headers)
        .expect(200);
      expect(list.body.data.items).toHaveLength(2);
      const detail = await request(app)
        .get(`${SESSIONS_URL}/${S_A2}`)
        .set(headers)
        .expect(200);
      expect(detail.body.data.session.session_id).toBe(S_A2);
    }
  });

  // ---- overview ---------------------------------------------------------

  it("4. overview is empty (zeros) when no live sessions exist", async () => {
    const res = await request(app)
      .get(OVERVIEW_URL)
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.totals).toEqual({
      restaurants: 0,
      active_sessions: 0,
      bill_requested_sessions: 0,
      pending_service_requests: 0,
    });
    expect(res.body.data.by_restaurant).toEqual([]);
    expect(typeof res.body.data.generated_at).toBe("string");
  });

  it("5. overview aggregates live sessions across distinct restaurants and excludes CLOSED", async () => {
    seedLiveFixture();
    // CLOSED session on its own Biryani table must not appear.
    seedTable("10000000-0000-4000-8000-000000000099", REST_A, "T99");
    seedSession(
      makeSession({
        id: "99000000-0000-4000-8000-000000000001",
        restaurantId: REST_A,
        tableId: "10000000-0000-4000-8000-000000000099",
        status: "CLOSED",
        openedAt: "2026-08-24T07:00:00.000Z",
      }),
    );

    const res = await request(app)
      .get(OVERVIEW_URL)
      .set(authHeaders())
      .expect(200);
    const data = res.body.data;
    expect(data.totals).toEqual({
      restaurants: 2,
      active_sessions: 4,
      bill_requested_sessions: 1,
      pending_service_requests: 2,
    });
    expect(data.by_restaurant).toHaveLength(2);
    expect(data.by_restaurant[0]).toEqual({
      restaurant_id: REST_A,
      restaurant_name: REST_A_NAME,
      active_sessions: 3,
      bill_requested_sessions: 1,
      pending_service_requests: 2,
    });
    expect(data.by_restaurant[1]).toEqual({
      restaurant_id: REST_B,
      restaurant_name: REST_B_NAME,
      active_sessions: 1,
      bill_requested_sessions: 0,
      pending_service_requests: 0,
    });
  });

  // ---- session list -----------------------------------------------------

  it("6. session list is empty when no live sessions exist", async () => {
    const res = await request(app)
      .get(SESSIONS_URL)
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 20, total: 0 });
  });

  it("7. list filters by restaurant_id (cross-restaurant composition)", async () => {
    seedLiveFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}?restaurant_id=${REST_A}`)
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.pagination.total).toBe(3);
    for (const row of res.body.data.items) {
      expect(row.restaurant_id).toBe(REST_A);
      expect(row.restaurant_name).toBe(REST_A_NAME);
    }
    const green = await request(app)
      .get(`${SESSIONS_URL}?restaurant_id=${REST_B}`)
      .set(authHeaders())
      .expect(200);
    expect(green.body.data.pagination.total).toBe(1);
    expect(green.body.data.items[0].session_id).toBe(S_B1);
  });

  it("8. list filters by status (each live status; CLOSED never listed)", async () => {
    seedLiveFixture();
    const byStatus = async (
      status: string,
      expectedSessionIds: string[],
    ): Promise<void> => {
      const res = await request(app)
        .get(`${SESSIONS_URL}?status=${status}`)
        .set(authHeaders())
        .expect(200);
      expect(
        res.body.data.items.map((row: { session_id: string }) => row.session_id),
      ).toEqual(expectedSessionIds);
      expect(res.body.data.pagination.total).toBe(expectedSessionIds.length);
    };
    await byStatus("OPEN", [S_A1]);
    await byStatus("BILL_REQUESTED", [S_A2]);
    await byStatus("ACTIVE", [S_A3]);
    await byStatus("PAYMENT_PENDING", [S_B1]);
  });

  it("9. list filters by zone_id", async () => {
    seedLiveFixture();
    const zA = await request(app)
      .get(`${SESSIONS_URL}?zone_id=${Z_A1}`)
      .set(authHeaders())
      .expect(200);
    expect(zA.body.data.pagination.total).toBe(1);
    expect(zA.body.data.items[0].session_id).toBe(S_A1);
    const zB = await request(app)
      .get(`${SESSIONS_URL}?zone_id=${Z_B1}`)
      .set(authHeaders())
      .expect(200);
    expect(zB.body.data.pagination.total).toBe(1);
    expect(zB.body.data.items[0].session_id).toBe(S_B1);
  });

  it("10. list combines restaurant + status + zone filters", async () => {
    seedLiveFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}?restaurant_id=${REST_A}&status=OPEN&zone_id=${Z_A1}`)
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.pagination.total).toBe(1);
    expect(res.body.data.items[0].session_id).toBe(S_A1);
    // Biryani OPEN + zone filter that no Biryani OPEN session is in -> empty.
    const none = await request(app)
      .get(`${SESSIONS_URL}?restaurant_id=${REST_A}&status=OPEN&zone_id=${Z_B1}`)
      .set(authHeaders())
      .expect(200);
    expect(none.body.data.pagination.total).toBe(0);
    expect(none.body.data.items).toEqual([]);
  });

  it("11. default sort is opened_at desc", async () => {
    seedLiveFixture();
    const res = await request(app)
      .get(SESSIONS_URL)
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.pagination.total).toBe(4);
    expect(
      res.body.data.items.map((row: { session_id: string }) => row.session_id),
    ).toEqual([S_B1, S_A2, S_A1, S_A3]);
  });

  it("11b. equal opened_at tie-breaks deterministically by session_id asc", async () => {
    seedTieBreakFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}?restaurant_id=${REST_A}`)
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.pagination.total).toBe(2);
    expect(
      res.body.data.items.map((row: { session_id: string }) => row.session_id),
    ).toEqual([
      "a1000000-0000-4000-8000-0000000000a1",
      "a1000000-0000-4000-8000-0000000000a5",
    ]);
  });

  it("12. list supports alternate sort/order (updated_at asc, table_label desc)", async () => {
    seedLiveFixture();
    const byUpdated = await request(app)
      .get(`${SESSIONS_URL}?sort=updated_at&order=asc`)
      .set(authHeaders())
      .expect(200);
    expect(
      byUpdated.body.data.items.map(
        (row: { session_id: string }) => row.session_id,
      ),
    ).toEqual([S_A3, S_A1, S_A2, S_B1]);

    const byLabel = await request(app)
      .get(`${SESSIONS_URL}?sort=table_label&order=desc`)
      .set(authHeaders())
      .expect(200);
    expect(
      byLabel.body.data.items.map(
        (row: { session_id: string }) => row.session_id,
      ),
    ).toEqual([S_A3, S_A2, S_A1, S_B1]);
  });

  it("13. list paginates with total preserved", async () => {
    seedLiveFixture();
    const page1 = await request(app)
      .get(`${SESSIONS_URL}?sort=opened_at&order=desc&page=1&limit=2`)
      .set(authHeaders())
      .expect(200);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.pagination).toEqual({ page: 1, limit: 2, total: 4 });
    expect(
      page1.body.data.items.map((row: { session_id: string }) => row.session_id),
    ).toEqual([S_B1, S_A2]);

    const page2 = await request(app)
      .get(`${SESSIONS_URL}?sort=opened_at&order=desc&page=2&limit=2`)
      .set(authHeaders())
      .expect(200);
    expect(
      page2.body.data.items.map((row: { session_id: string }) => row.session_id),
    ).toEqual([S_A1, S_A3]);
    expect(page2.body.data.pagination.total).toBe(4);

    const past = await request(app)
      .get(`${SESSIONS_URL}?sort=opened_at&order=desc&page=3&limit=2`)
      .set(authHeaders())
      .expect(200);
    expect(past.body.data.items).toEqual([]);
    expect(past.body.data.pagination.total).toBe(4);
  });

  it("14. invalid status/sort/order/page/limit/uuids -> 400 VALIDATION_ERROR", async () => {
    seedLiveFixture();
    const cases = [
      `${SESSIONS_URL}?status=CLOSED`,
      `${SESSIONS_URL}?status=PAID`,
      `${SESSIONS_URL}?sort=created_at`,
      `${SESSIONS_URL}?sort=opened`,
      `${SESSIONS_URL}?order=up`,
      `${SESSIONS_URL}?order=DESC`,
      `${SESSIONS_URL}?page=0`,
      `${SESSIONS_URL}?page=-1`,
      `${SESSIONS_URL}?page=1.5`,
      `${SESSIONS_URL}?page=abc`,
      `${SESSIONS_URL}?limit=0`,
      `${SESSIONS_URL}?limit=101`,
      `${SESSIONS_URL}?limit=1.5`,
      `${SESSIONS_URL}?restaurant_id=not-a-uuid`,
      `${SESSIONS_URL}?zone_id=not-a-uuid`,
    ];
    for (const url of cases) {
      const res = await request(app).get(url).set(authHeaders()).expect(400);
      expect(res.body.error.code, url).toBe("VALIDATION_ERROR");
    }
    // Boundary-acceptable limit=100 / page=1 are valid.
    await request(app)
      .get(`${SESSIONS_URL}?limit=100&page=1`)
      .set(authHeaders())
      .expect(200);
  });

  // ---- detail -----------------------------------------------------------

  it("15. known live session -> 200 with full explicit DTO", async () => {
    seedDetailFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}/${S_B1}`)
      .set(authHeaders())
      .expect(200);
    const data = res.body.data;
    expect(data.session).toEqual({
      session_id: S_B1,
      status: "PAYMENT_PENDING",
      opened_at: "2026-08-24T09:00:00.000Z",
      updated_at: "2026-08-24T09:15:00.000Z",
      bill_requested_at: "2026-08-24T09:07:00.000Z",
      payment_pending_at: "2026-08-24T09:10:00.000Z",
    });
    expect(data.restaurant).toEqual({
      restaurant_id: REST_A,
      restaurant_name: REST_A_NAME,
    });
    expect(data.table).toEqual({
      table_id: T_A1,
      table_label: "T1",
      seat_count: 4,
    });
    expect(data.zone).toEqual({ zone_id: Z_A1, zone_name: "Main Hall" });
    // Orders: sorted created_at asc; CANCELLED included truthfully.
    expect(data.orders.map((o: { id: string }) => o.id)).toEqual(["o-d1", "o-d2"]);
    expect(data.orders[1].status).toBe("CANCELLED");
    // Service requests: sorted created_at asc, four artifacts.
    expect(
      data.service_requests.map((r: { id: string }) => r.id),
    ).toEqual(["r-d-water", "r-d-cutlery", "r-d-tissue", R_B1_BILL]);
    // Bill lifecycle from the completed BRING_BILL artifact.
    expect(data.bill.status).toBe("DELIVERED");
    expect(data.bill.requested_at).toBe("2026-08-24T09:07:00.000Z");
    expect(data.bill.acknowledged_at).toBe("2026-08-24T09:08:00.000Z");
    expect(data.bill.delivered_at).toBe("2026-08-24T09:09:00.000Z");
  });

  it("16. detail orders/items expose only wire fields and preserve amounts", async () => {
    seedDetailFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}/${S_B1}`)
      .set(authHeaders())
      .expect(200);
    const order = res.body.data.orders[0];
    expect(order).toMatchObject({
      id: "o-d1",
      status: "SERVED",
      total_amount: 290,
      created_at: "2026-08-24T09:01:00.000Z",
    });
    expect(order.items).toEqual([
      { name: "Paneer Tikka", quantity: 2, item_subtotal: 200 },
      { name: "Butter Naan", quantity: 3, item_subtotal: 90 },
    ]);
    // The cancelled order's total is still surfaced with its real status.
    expect(res.body.data.orders[1].total_amount).toBe(200);
  });

  it("17. detail service_requests expose wire fields only", async () => {
    seedDetailFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}/${S_B1}`)
      .set(authHeaders())
      .expect(200);
    const byId = new Map(
      res.body.data.service_requests.map(
        (r: { id: string }) => [r.id, r] as const,
      ),
    );
    const water = byId.get("r-d-water");
    expect(water).toEqual({
      id: "r-d-water",
      request_type: "WATER",
      status: "COMPLETED",
      note: null,
      created_at: "2026-08-24T09:02:00.000Z",
      acknowledged_at: "2026-08-24T09:03:00.000Z",
      completed_at: "2026-08-24T09:04:00.000Z",
      cancelled_at: null,
    });
    const cancelled = byId.get("r-d-tissue");
    expect(cancelled).toMatchObject({
      request_type: "TISSUE",
      status: "CANCELLED",
      cancelled_at: "2026-08-24T09:06:00.000Z",
    });
  });

  it("18. unknown session -> 404; malformed sessionId -> 400", async () => {
    await request(app)
      .get(`${SESSIONS_URL}/99999999-9999-4999-8999-999999999999`)
      .set(authHeaders())
      .expect(404);
    const bad = await request(app)
      .get(`${SESSIONS_URL}/not-a-uuid`)
      .set(authHeaders())
      .expect(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("19. known CLOSED session detail -> 404 (live-ops endpoint)", async () => {
    const closedId = "99000000-0000-4000-8000-000000000001";
    seedTable("10000000-0000-4000-8000-000000000099", REST_A, "T99");
    seedSession(
      makeSession({
        id: closedId,
        restaurantId: REST_A,
        tableId: "10000000-0000-4000-8000-000000000099",
        status: "CLOSED",
        openedAt: "2026-08-24T07:00:00.000Z",
      }),
    );
    const res = await request(app)
      .get(`${SESSIONS_URL}/${closedId}`)
      .set(authHeaders())
      .expect(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("20. bill lifecycle states derive from the BRING_BILL artifact (NONE/REQUESTED/ACKNOWLEDGED/DELIVERED)", async () => {
    // NONE: OPEN session, no BRING_BILL, no frozen bill.
    seedBillStateFixture({
      sessionId: "60000000-0000-4000-8000-000000000011",
      tableId: "10000000-0000-4000-8000-000000000011",
      status: "OPEN",
      openedAt: "2026-08-24T11:00:00.000Z",
    });
    const none = await request(app)
      .get(`${SESSIONS_URL}/60000000-0000-4000-8000-000000000011`)
      .set(authHeaders())
      .expect(200);
    expect(none.body.data.bill.status).toBe("NONE");
    expect(none.body.data.bill.requested_at).toBeNull();
    expect(none.body.data.bill.acknowledged_at).toBeNull();
    expect(none.body.data.bill.delivered_at).toBeNull();
    expect(none.body.data.bill.totals).toBeNull();

    // REQUESTED: BILL_REQUESTED + BRING_BILL PENDING.
    seedBillStateFixture({
      sessionId: "60000000-0000-4000-8000-000000000012",
      tableId: "10000000-0000-4000-8000-000000000012",
      status: "BILL_REQUESTED",
      openedAt: "2026-08-24T11:10:00.000Z",
      billRequestedAt: "2026-08-24T11:12:00.000Z",
      withBill: true,
      bringBill: {
        id: "b1000000-0000-4000-8000-000000000012",
        status: "PENDING",
        createdAt: "2026-08-24T11:12:00.000Z",
      },
    });
    const requested = await request(app)
      .get(`${SESSIONS_URL}/60000000-0000-4000-8000-000000000012`)
      .set(authHeaders())
      .expect(200);
    expect(requested.body.data.bill.status).toBe("REQUESTED");
    expect(requested.body.data.bill.requested_at).toBe("2026-08-24T11:12:00.000Z");
    expect(requested.body.data.bill.acknowledged_at).toBeNull();
    expect(requested.body.data.bill.delivered_at).toBeNull();

    // ACKNOWLEDGED: BILL_REQUESTED + BRING_BILL ACKNOWLEDGED.
    seedBillStateFixture({
      sessionId: "60000000-0000-4000-8000-000000000013",
      tableId: "10000000-0000-4000-8000-000000000013",
      status: "BILL_REQUESTED",
      openedAt: "2026-08-24T11:20:00.000Z",
      billRequestedAt: "2026-08-24T11:22:00.000Z",
      withBill: true,
      bringBill: {
        id: "b1000000-0000-4000-8000-000000000013",
        status: "ACKNOWLEDGED",
        createdAt: "2026-08-24T11:22:00.000Z",
        acknowledgedAt: "2026-08-24T11:23:00.000Z",
      },
    });
    const acknowledged = await request(app)
      .get(`${SESSIONS_URL}/60000000-0000-4000-8000-000000000013`)
      .set(authHeaders())
      .expect(200);
    expect(acknowledged.body.data.bill.status).toBe("ACKNOWLEDGED");
    expect(acknowledged.body.data.bill.acknowledged_at).toBe(
      "2026-08-24T11:23:00.000Z",
    );
    expect(acknowledged.body.data.bill.delivered_at).toBeNull();

    // DELIVERED: PAYMENT_PENDING + BRING_BILL COMPLETED.
    seedBillStateFixture({
      sessionId: "60000000-0000-4000-8000-000000000014",
      tableId: "10000000-0000-4000-8000-000000000014",
      status: "PAYMENT_PENDING",
      openedAt: "2026-08-24T11:30:00.000Z",
      billRequestedAt: "2026-08-24T11:32:00.000Z",
      paymentPendingAt: "2026-08-24T11:34:00.000Z",
      withBill: true,
      bringBill: {
        id: "b1000000-0000-4000-8000-000000000014",
        status: "COMPLETED",
        createdAt: "2026-08-24T11:32:00.000Z",
        acknowledgedAt: "2026-08-24T11:33:00.000Z",
        completedAt: "2026-08-24T11:34:00.000Z",
      },
    });
    const delivered = await request(app)
      .get(`${SESSIONS_URL}/60000000-0000-4000-8000-000000000014`)
      .set(authHeaders())
      .expect(200);
    expect(delivered.body.data.bill.status).toBe("DELIVERED");
    expect(delivered.body.data.bill.requested_at).toBe("2026-08-24T11:32:00.000Z");
    expect(delivered.body.data.bill.acknowledged_at).toBe("2026-08-24T11:33:00.000Z");
    expect(delivered.body.data.bill.delivered_at).toBe("2026-08-24T11:34:00.000Z");
  });

  it("21. frozen bill totals are preserved exactly and PAYMENT_PENDING is only a session status", async () => {
    seedDetailFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}/${S_B1}`)
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.bill.totals).toEqual({ ...KNOWN_BILL_TOTALS, frozen_at: "2026-08-24T09:07:00.000Z" });
    expect(res.body.data.session.status).toBe("PAYMENT_PENDING");
    expect(res.body.data.bill.status).toBe("DELIVERED");
    // No fabricated paid/settled/payment-success/closed anywhere in the body.
    assertResponseClean(res.body);
  });

  // ---- list row semantics (bill_status / counts) ------------------------

  it("22. list rows derive order_count, pending_service_request_count and bill_status", async () => {
    seedLiveFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}?sort=opened_at&order=desc`)
      .set(authHeaders())
      .expect(200);
    const byId = new Map(
      res.body.data.items.map((row: { session_id: string }) => [
        row.session_id,
        row,
      ] as const),
    );
    expect(byId.get(S_B1)).toMatchObject({
      status: "PAYMENT_PENDING",
      table_label: "GT1",
      zone_name: "Garden",
      order_count: 2,
      pending_service_request_count: 0,
      bill_status: "DELIVERED",
      opened_at: "2026-08-24T09:20:00.000Z",
      updated_at: "2026-08-24T09:30:00.000Z",
    });
    expect(byId.get(S_A2)).toMatchObject({
      status: "BILL_REQUESTED",
      order_count: 0,
      pending_service_request_count: 0,
      bill_status: "REQUESTED",
    });
    expect(byId.get(S_A1)).toMatchObject({
      status: "OPEN",
      zone_name: "Main Hall",
      order_count: 1,
      pending_service_request_count: 1,
      bill_status: "NONE",
    });
    expect(byId.get(S_A3)).toMatchObject({
      status: "ACTIVE",
      zone_name: null,
      order_count: 0,
      pending_service_request_count: 1,
      bill_status: "NONE",
    });
  });

  // ---- privacy deep-negative -------------------------------------------

  it("23. overview response is deep-negative for sensitive fields", async () => {
    seedLiveFixture();
    const res = await request(app)
      .get(OVERVIEW_URL)
      .set(authHeaders())
      .expect(200);
    assertResponseClean(res.body);
  });

  it("24. session list response is deep-negative for sensitive fields", async () => {
    seedLiveFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}?limit=100`)
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    assertResponseClean(res.body);
  });

  it("25. detail response is deep-negative for sensitive fields", async () => {
    seedDetailFixture();
    const res = await request(app)
      .get(`${SESSIONS_URL}/${S_B1}`)
      .set(authHeaders())
      .expect(200);
    assertResponseClean(res.body);
  });
});
