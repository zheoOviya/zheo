import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  DineInOrderStatus,
  DiningSessionStatus,
  ServiceRequestStatus,
  ServiceRequestType,
} from "@snakzap/types";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { resetCatalogRepository } from "./catalog";
import {
  getDineInTableBoardReadRepository,
  getDineInTransactionPort,
  resetDineInState,
} from "../repositories/dineInComposition";
import {
  sharedChainRepo,
  sharedUserRoleRepo,
} from "../repositories/shared";
import type {
  DineInTransactionRepos,
  DineInOrderWithItemsDTO,
  DineZoneDTO,
  DiningSessionDTO,
  RestaurantTableDTO,
  ServiceRequestDTO,
  VendorTableBoardRow,
} from "../repositories/dineInContracts";

// ============================================
// DINE-OPS3 vendor Dine-In table/session board:
//   GET /api/vendor/dine-in/tables?restaurant_id=<uuid>
//
// Read-only occupancy board over the DINE-OPS3 read-model repository. Every
// restaurant table (including disabled tables) is returned with the
// server-derived live session and the actionable open-order / open-request
// counts. Occupancy is DERIVED from the live-session invariant — never stored
// on the table and never client-supplied. BILL_REQUESTED travels on
// session.status (never as a request count); BRING_BILL is excluded from
// open_request_count (the billing flow owns that artifact). No
// owner/customer identity and no table_token are exposed. All tables in the
// restaurant come back deterministically ordered by (label ASC, id ASC).
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001"; // Biryani House
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002"; // Green Bowl
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner
const GREEN_OWNER_ID = "e0000000-0000-4000-a000-000000000002"; // Green Bowl owner
const STAFF_ID = "e0000000-0000-4000-a000-000000000099"; // scoped Biryani House staff
const ADMIN_ID = "00000000-0000-4000-8000-0000000000aa";
const CONSUMER_ID = "u00000000-0000-4000-8000-000000000001";
const UNKNOWN_REST_ID = "99999999-9999-4999-8999-999999999999";

const CONSUMER_SEED = "u00000000-0000-4000-8000-000000000001";

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
  opts: {
    zoneId?: string | null;
    seatCount?: number | null;
    isActive?: boolean;
  } = {},
): RestaurantTableDTO {
  return {
    id,
    restaurant_id: restaurantId,
    zone_id: opts.zoneId ?? null,
    label,
    table_token: `token-${id}`,
    seat_count: opts.seatCount ?? null,
    is_active: opts.isActive ?? true,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
}

function makeZone(
  id: string,
  restaurantId: string,
  name: string,
): DineZoneDTO {
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
  billRequestedAt: string | null = null,
): DiningSessionDTO {
  return {
    id,
    restaurant_id: restaurantId,
    table_id: tableId,
    owner_user_id: CONSUMER_SEED,
    status,
    bill_requested_at: billRequestedAt,
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-08-24T10:00:00.000Z",
    updated_at: "2026-08-24T10:00:00.000Z",
  };
}

function makeOrder(
  id: string,
  restaurantId: string,
  sessionId: string,
  status: DineInOrderStatus,
): DineInOrderWithItemsDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    placed_by: CONSUMER_SEED,
    status,
    total_amount: 462,
    notes: null,
    served_at: null,
    cancelled_at: null,
    cancelled_by: null,
    created_at: "2026-08-24T10:05:00.000Z",
    updated_at: "2026-08-24T10:05:00.000Z",
    items: [
      {
        id: `itm-${id}`,
        dine_in_order_id: id,
        restaurant_id: restaurantId,
        menu_item_id: "b0000000-0000-4000-8000-000000000001",
        name: "Chicken Biryani",
        base_price: 220,
        quantity: 1,
        customizations: [],
        customization_total: 0,
        item_subtotal: 220,
        created_at: "2026-08-24T10:05:00.000Z",
      },
    ],
  };
}

function makeRequest(
  id: string,
  restaurantId: string,
  sessionId: string,
  requestType: ServiceRequestType,
  status: ServiceRequestStatus,
): ServiceRequestDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    requested_by: CONSUMER_SEED,
    request_type: requestType,
    status,
    note: null,
    acknowledged_by: null,
    acknowledged_at: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-08-24T10:06:00.000Z",
    updated_at: "2026-08-24T10:06:00.000Z",
  };
}

function sharedRepos(): DineInTransactionRepos {
  return (getDineInTransactionPort() as unknown as {
    repos: DineInTransactionRepos;
  }).repos;
}

// Seeding seam for the memory-only zone registry held by the shared board
// repository (the zone store is not part of the transaction repo set).
function seedZone(zone: DineZoneDTO): void {
  (getDineInTableBoardReadRepository() as unknown as {
    _seedZone(z: DineZoneDTO): DineZoneDTO;
  })._seedZone(zone);
}

function seedTable(table: RestaurantTableDTO): void {
  (sharedRepos().restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  })._seed(table);
}

function seedSession(session: DiningSessionDTO): void {
  (sharedRepos().diningSessions as unknown as {
    _seed(s: DiningSessionDTO): DiningSessionDTO;
  })._seed(session);
}

function seedOrder(order: DineInOrderWithItemsDTO): void {
  (sharedRepos().dineInOrders as unknown as {
    _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
  })._seed(order);
}

function seedRequest(requestDTO: ServiceRequestDTO): void {
  (sharedRepos().serviceRequests as unknown as {
    _seed(r: ServiceRequestDTO): ServiceRequestDTO;
  })._seed(requestDTO);
}

async function getBoard(
  app: Express,
  restaurantId: string,
  userId?: string,
  role?: string,
): Promise<VendorTableBoardRow[]> {
  const res = await request(app)
    .get(`/api/vendor/dine-in/tables?restaurant_id=${restaurantId}`)
    .set(authHeaders(userId, role))
    .expect(200);
  expect(res.body.success).toBe(true);
  expect(res.body.error).toBeNull();
  return res.body.data as VendorTableBoardRow[];
}

describe("Vendor Dine-In table/session board route (DINE-OPS3)", () => {
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

  it("1. no token is rejected at the vendor mount", async () => {
    await request(app)
      .get(`/api/vendor/dine-in/tables?restaurant_id=${REST_ID}`)
      .expect(401);
  });

  it("2. CONSUMER role is rejected at the vendor mount", async () => {
    await request(app)
      .get(`/api/vendor/dine-in/tables?restaurant_id=${REST_ID}`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
  });

  // ---- validation + authorization ----------------------------------------

  it("3. invalid restaurant_id is a VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .get("/api/vendor/dine-in/tables?restaurant_id=not-a-uuid")
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("4. a foreign existing restaurant is FORBIDDEN (no data leak)", async () => {
    seedTable(makeTable("t-foreign", GREEN_BOWL_ID, "G1"));
    const res = await request(app)
      .get(`/api/vendor/dine-in/tables?restaurant_id=${GREEN_BOWL_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("5. an unknown restaurant is NOT_FOUND for a vendor (no existence oracle)", async () => {
    const res = await request(app)
      .get(`/api/vendor/dine-in/tables?restaurant_id=${UNKNOWN_REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("6. accessible restaurant with no tables resolves truthfully to an empty board", async () => {
    const rows = await getBoard(app, REST_ID, OWNER_ID, "VENDOR_OWNER");
    expect(rows).toEqual([]);
  });

  // ---- board semantics ----------------------------------------------------

  it("7. FREE/OPEN/ACTIVE/BILL_REQUESTED/PAYMENT_PENDING + zone/null-zone + disabled + no identity/token leak", async () => {
    seedZone(makeZone("z-a", REST_ID, "Terrace"));
    seedZone(makeZone("z-b", REST_ID, "Mezzanine"));

    seedTable(makeTable("t-a", REST_ID, "A2", { zoneId: "z-a", seatCount: 2 }));
    seedTable(makeTable("t-b", REST_ID, "B1", { zoneId: "z-a", seatCount: 4 }));
    seedTable(makeTable("t-c", REST_ID, "C1", { seatCount: null }));
    seedTable(
      makeTable("t-d", REST_ID, "D1", { zoneId: "z-b", seatCount: 4, isActive: false }),
    );
    seedTable(makeTable("t-e", REST_ID, "E1", { zoneId: "z-b", seatCount: 6 }));

    seedSession(makeSession("s-a", REST_ID, "t-a", "OPEN"));
    seedSession(makeSession("s-b", REST_ID, "t-b", "ACTIVE"));
    seedSession(
      makeSession("s-e", REST_ID, "t-e", "BILL_REQUESTED", "2026-08-24T10:20:00.000Z"),
    );
    // Disabled table + live session coexist -> both facts surface truthfully.
    seedSession(
      makeSession("s-d", REST_ID, "t-d", "PAYMENT_PENDING", "2026-08-24T10:25:00.000Z"),
    );

    // ACTIVE table t-b: actionable orders PLACED + READY_TO_SERVE and a WATER
    // PENDING request; SERVED/CANCELLED and BRING_BILL must NOT count.
    seedOrder(makeOrder("o-b1", REST_ID, "s-b", "PLACED"));
    seedOrder(makeOrder("o-b2", REST_ID, "s-b", "READY_TO_SERVE"));
    seedOrder(makeOrder("o-b3", REST_ID, "s-b", "SERVED"));
    seedOrder(makeOrder("o-b4", REST_ID, "s-b", "CANCELLED"));
    seedRequest(makeRequest("r-b1", REST_ID, "s-b", "WATER", "PENDING"));
    seedRequest(makeRequest("r-b2", REST_ID, "s-b", "BRING_BILL", "PENDING"));

    // BILL_REQUESTED table t-e: BILL_REQUESTED travels on session.status even
    // when the only request artifact is an acknowledged BRING_BILL.
    seedRequest(makeRequest("r-e1", REST_ID, "s-e", "BRING_BILL", "ACKNOWLEDGED"));

    const rows = await getBoard(app, REST_ID, OWNER_ID, "VENDOR_OWNER");

    expect(rows.map((row) => row.table.id)).toEqual(["t-a", "t-b", "t-c", "t-d", "t-e"]);
    expect(rows.map((row) => row.table.label)).toEqual(["A2", "B1", "C1", "D1", "E1"]);

    // OPEN table A2 (Terrace zone).
    expect(rows[0]!.table).toEqual({ id: "t-a", label: "A2", seat_count: 2, is_active: true });
    expect(rows[0]!.zone).toEqual({ id: "z-a", name: "Terrace" });
    expect(rows[0]!.session).toEqual({
      id: "s-a",
      status: "OPEN",
      opened_at: "2026-08-24T10:00:00.000Z",
      bill_requested_at: null,
    });
    expect(rows[0]!.open_order_count).toBe(0);
    expect(rows[0]!.open_request_count).toBe(0);

    // ACTIVE table B1 counts only actionable orders/requests.
    expect(rows[1]!.table).toEqual({ id: "t-b", label: "B1", seat_count: 4, is_active: true });
    expect(rows[1]!.zone).toEqual({ id: "z-a", name: "Terrace" });
    expect(rows[1]!.session).toEqual({
      id: "s-b",
      status: "ACTIVE",
      opened_at: "2026-08-24T10:00:00.000Z",
      bill_requested_at: null,
    });
    expect(rows[1]!.open_order_count).toBe(2);
    expect(rows[1]!.open_request_count).toBe(1);

    // FREE table C1: no session, null zone, null seat_count, zero counts.
    expect(rows[2]!.table).toEqual({ id: "t-c", label: "C1", seat_count: null, is_active: true });
    expect(rows[2]!.zone).toBeNull();
    expect(rows[2]!.session).toBeNull();
    expect(rows[2]!.open_order_count).toBe(0);
    expect(rows[2]!.open_request_count).toBe(0);

    // Disabled table D1 still carries its live PAYMENT_PENDING session.
    expect(rows[3]!.table).toEqual({ id: "t-d", label: "D1", seat_count: 4, is_active: false });
    expect(rows[3]!.zone).toEqual({ id: "z-b", name: "Mezzanine" });
    expect(rows[3]!.session).toEqual({
      id: "s-d",
      status: "PAYMENT_PENDING",
      opened_at: "2026-08-24T10:00:00.000Z",
      bill_requested_at: "2026-08-24T10:25:00.000Z",
    });
    expect(rows[3]!.open_order_count).toBe(0);
    expect(rows[3]!.open_request_count).toBe(0);

    // BILL_REQUESTED table E1: status carried, request count stays 0 (BRING_BILL excluded).
    expect(rows[4]!.table).toEqual({ id: "t-e", label: "E1", seat_count: 6, is_active: true });
    expect(rows[4]!.zone).toEqual({ id: "z-b", name: "Mezzanine" });
    expect(rows[4]!.session).toEqual({
      id: "s-e",
      status: "BILL_REQUESTED",
      opened_at: "2026-08-24T10:00:00.000Z",
      bill_requested_at: "2026-08-24T10:20:00.000Z",
    });
    expect(rows[4]!.open_order_count).toBe(0);
    expect(rows[4]!.open_request_count).toBe(0);

    // No owner/customer identity and no table_token on any row.
    for (const row of rows) {
      expect(row).not.toHaveProperty("table_token");
      expect(row).not.toHaveProperty("owner_user_id");
      expect(row.table).not.toHaveProperty("table_token");
      expect(row.table).not.toHaveProperty("created_at");
      if (row.session) {
        expect(row.session).not.toHaveProperty("owner_user_id");
        expect(row.session).not.toHaveProperty("requested_by");
      }
    }
  });

  it("8. count boundaries: terminal orders/requests and BRING_BILL never count", async () => {
    seedZone(makeZone("z-x", REST_ID, "X"));
    seedTable(makeTable("t-x", REST_ID, "X1", { zoneId: "z-x", seatCount: 4 }));
    seedSession(makeSession("s-x", REST_ID, "t-x", "ACTIVE"));

    for (const status of ["PLACED", "PREPARING", "READY_TO_SERVE", "SERVED", "CANCELLED"]) {
      seedOrder(makeOrder(`o-x-${status}`, REST_ID, "s-x", status as DineInOrderStatus));
    }
    for (const [i, [type, status]] of (
      [
        ["WATER", "PENDING"],
        ["CUTLERY", "ACKNOWLEDGED"],
        ["EXTRA_PLATE", "COMPLETED"],
        ["CALL_STAFF", "CANCELLED"],
        ["BRING_BILL", "PENDING"],
        ["BRING_BILL", "ACKNOWLEDGED"],
      ] as Array<[ServiceRequestType, ServiceRequestStatus]>
    ).entries()) {
      seedRequest(makeRequest(`r-x-${i}`, REST_ID, "s-x", type, status));
    }

    const rows = await getBoard(app, REST_ID, OWNER_ID, "VENDOR_OWNER");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.open_order_count).toBe(3);
    expect(rows[0]!.open_request_count).toBe(2);
  });

  it("9. rows are deterministically ordered by (label ASC, id ASC)", async () => {
    seedTable(makeTable("t-z", REST_ID, "T2"));
    seedTable(makeTable("t-y", REST_ID, "T1", { seatCount: 4 }));
    seedTable(makeTable("t-x", REST_ID, "T1", { seatCount: 2 }));

    const rows = await getBoard(app, REST_ID, OWNER_ID, "VENDOR_OWNER");
    expect(rows.map((row) => row.table.id)).toEqual(["t-x", "t-y", "t-z"]);
    expect(rows.map((row) => row.table.label)).toEqual(["T1", "T1", "T2"]);
  });

  it("10. other-restaurant tables never leak into the board (ADMIN read)", async () => {
    seedZone(makeZone("z-a", REST_ID, "Terrace"));
    seedZone(makeZone("z-g", GREEN_BOWL_ID, "Garden"));
    seedTable(makeTable("t-1", REST_ID, "T1", { zoneId: "z-a" }));
    seedTable(makeTable("t-g1", GREEN_BOWL_ID, "G1", { zoneId: "z-g" }));
    seedTable(makeTable("t-g2", GREEN_BOWL_ID, "G2", { zoneId: "z-g" }));
    seedSession(makeSession("s-1", REST_ID, "t-1", "OPEN"));
    seedSession(makeSession("s-g1", GREEN_BOWL_ID, "t-g1", "PAYMENT_PENDING", "2026-08-24T10:20:00.000Z"));

    const rows = await getBoard(app, REST_ID, ADMIN_ID, "ADMIN");
    expect(rows.map((row) => row.table.id)).toEqual(["t-1"]);
    expect(rows[0]!.zone).toEqual({ id: "z-a", name: "Terrace" });
  });

  it("11. scoped staff and ADMIN can read the board for the restaurant", async () => {
    seedTable(makeTable("t-1", REST_ID, "T1"));
    sharedUserRoleRepo._seed({
      id: "ur-board-staff-1",
      user_id: STAFF_ID,
      scope_type: "restaurant",
      scope_id: REST_ID,
      role: "VENDOR_STAFF",
      created_at: "2026-08-24T00:00:00.000Z",
    });

    const staffRows = await getBoard(app, REST_ID, STAFF_ID, "VENDOR_STAFF");
    expect(staffRows.map((row) => row.table.id)).toEqual(["t-1"]);

    const adminRows = await getBoard(app, REST_ID, ADMIN_ID, "ADMIN");
    expect(adminRows.map((row) => row.table.id)).toEqual(["t-1"]);
  });

  it("12. ADMIN on an unknown restaurant reads a truthful empty board", async () => {
    seedTable(makeTable("t-1", REST_ID, "T1"));
    const rows = await getBoard(app, UNKNOWN_REST_ID, ADMIN_ID, "ADMIN");
    expect(rows).toEqual([]);
  });

  it("13. terminal CLOSED session is not live (table FREE) and an unresolvable zone_id renders zone null", async () => {
    seedZone(makeZone("z-a", REST_ID, "Terrace"));
    // t-1 has a real zone + a CLOSED session (terminal -> not live -> FREE).
    seedTable(makeTable("t-1", REST_ID, "T1", { zoneId: "z-a", seatCount: 4 }));
    // t-2 references a zone that does not exist in this restaurant.
    seedTable(makeTable("t-2", REST_ID, "T2", { zoneId: "z-ghost" }));
    seedSession(makeSession("s-1", REST_ID, "t-1", "CLOSED", "2026-08-24T10:20:00.000Z"));

    const rows = await getBoard(app, REST_ID, OWNER_ID, "VENDOR_OWNER");
    expect(rows.map((row) => row.table.id)).toEqual(["t-1", "t-2"]);

    // CLOSED is terminal and never a live session -> FREE (null) with 0 counts.
    expect(rows[0]!.table).toEqual({ id: "t-1", label: "T1", seat_count: 4, is_active: true });
    expect(rows[0]!.zone).toEqual({ id: "z-a", name: "Terrace" });
    expect(rows[0]!.session).toBeNull();
    expect(rows[0]!.open_order_count).toBe(0);
    expect(rows[0]!.open_request_count).toBe(0);

    // zone_id that does not resolve to a zone row -> truthful zone: null.
    expect(rows[1]!.table).toEqual({ id: "t-2", label: "T2", seat_count: null, is_active: true });
    expect(rows[1]!.zone).toBeNull();
    expect(rows[1]!.session).toBeNull();
  });
});
