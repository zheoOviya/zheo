import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServiceRequestStatus, ServiceRequestType } from "@snakzap/types";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { resetCatalogRepository } from "./catalog";
import {
  getDineInTransactionPort,
  resetDineInState,
} from "../repositories/dineInComposition";
import {
  sharedChainRepo,
  sharedUserRoleRepo,
} from "../repositories/shared";
import type {
  DineInTransactionRepos,
  DiningSessionDTO,
  RestaurantTableDTO,
  ServiceRequestDTO,
} from "../repositories/dineInContracts";

// ============================================
// DINE-OPS2 vendor Dine-In service-request operations:
//   GET  /api/vendor/dine-in/service-requests?restaurant_id=<uuid>
//   POST /api/vendor/dine-in/service-requests/:requestId/acknowledge
//   POST /api/vendor/dine-in/service-requests/:requestId/complete
//
// Product-functional wrapper over the frozen Dine-In service-request
// transitions. The queue read model is PENDING + ACKNOWLEDGED oldest-first,
// EXCLUDING BRING_BILL (the billing flow owns that artifact), with the table
// identity DERIVED server-side from the persisted session. Restaurant identity
// for mutation authorization is DERIVED server-side from the persisted request
// — never from body/query. Unauthorized restaurants must not reach the service
// mutation (zero mutation on 403). BRING_BILL acknowledge/complete are refused
// (409, same code the frozen service uses for its own create/cancel guard). No
// vendor cancel endpoint exists.
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001"; // Biryani House
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002"; // Green Bowl
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner
const GREEN_OWNER_ID = "e0000000-0000-4000-a000-000000000002"; // Green Bowl owner
const STAFF_ID = "e0000000-0000-4000-a000-000000000099"; // scoped Biryani House staff
const ADMIN_ID = "00000000-0000-4000-8000-0000000000aa";
const CONSUMER_ID = "u00000000-0000-4000-8000-000000000001";

const REQ_WATER_PENDING = "10000000-0000-4000-8000-000000000001";
const REQ_CUTLERY_ACK = "20000000-0000-4000-8000-000000000001";
const REQ_OTHER_PENDING = "30000000-0000-4000-8000-000000000001";
const REQ_BRING_BILL = "40000000-0000-4000-8000-000000000001";
const REQ_COMPLETED = "50000000-0000-4000-8000-000000000001";
const REQ_CANCELLED = "60000000-0000-4000-8000-000000000001";
const REQ_GREEN_PENDING = "70000000-0000-4000-8000-000000000001";
const REQ_UNKNOWN = "99999999-9999-4999-8999-999999999999";

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
): DiningSessionDTO {
  return {
    id,
    restaurant_id: restaurantId,
    table_id: tableId,
    owner_user_id: CONSUMER_ID,
    status: "OPEN",
    bill_requested_at: null,
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-08-24T10:00:00.000Z",
    updated_at: "2026-08-24T10:00:00.000Z",
  };
}

function makeRequest(
  id: string,
  restaurantId: string,
  sessionId: string,
  requestType: ServiceRequestType,
  status: ServiceRequestStatus,
  createdAt: string,
  note: string | null = null,
): ServiceRequestDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    requested_by: CONSUMER_ID,
    request_type: requestType,
    status,
    note,
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

function sharedRepos(): DineInTransactionRepos {
  return (getDineInTransactionPort() as unknown as {
    repos: DineInTransactionRepos;
  }).repos;
}

/**
 * Seeds the table + session + request a scenario needs, all in the shared
 * memory universe so both the read repo and the transaction service observe
 * the same rows. Seeding the same table/session id again simply overwrites
 * identical fixtures (Map semantics).
 */
function seedRequest(
  reqId: string,
  restaurantId: string,
  requestType: ServiceRequestType,
  status: ServiceRequestStatus,
  createdAt: string,
  note: string | null = null,
  opts: { tableId?: string; tableLabel?: string; sessionId?: string } = {},
) {
  const tableId = opts.tableId ?? "t1";
  const tableLabel = opts.tableLabel ?? "T1";
  const sessionId = opts.sessionId ?? "s1";
  const repos = sharedRepos();
  (repos.restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  })._seed(makeTable(tableId, restaurantId, tableLabel));
  (repos.diningSessions as unknown as {
    _seed(s: DiningSessionDTO): DiningSessionDTO;
  })._seed(makeSession(sessionId, restaurantId, tableId));
  (repos.serviceRequests as unknown as {
    _seed(r: ServiceRequestDTO): ServiceRequestDTO;
  })._seed(makeRequest(reqId, restaurantId, sessionId, requestType, status, createdAt, note));
}

async function currentRequestStatus(
  requestId: string,
): Promise<ServiceRequestStatus | null> {
  const request = await sharedRepos().serviceRequests.getById(requestId);
  return request?.status ?? null;
}

describe("Vendor Dine-In service-request operations route (DINE-OPS2)", () => {
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

  it("1. no token is rejected at the vendor mount (queue + mutations)", async () => {
    await request(app)
      .get(`/api/vendor/dine-in/service-requests?restaurant_id=${REST_ID}`)
      .expect(401);
    await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/acknowledge`)
      .expect(401);
    await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_CUTLERY_ACK}/complete`)
      .expect(401);
  });

  it("2. CONSUMER role is rejected at the vendor mount (queue + mutations)", async () => {
    await request(app)
      .get(`/api/vendor/dine-in/service-requests?restaurant_id=${REST_ID}`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
    await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/acknowledge`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
    await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_CUTLERY_ACK}/complete`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
  });

  // ---- queue read ---------------------------------------------------------

  it("3. invalid restaurant_id is a VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .get("/api/vendor/dine-in/service-requests?restaurant_id=not-a-uuid")
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("4. authorized owner sees only actionable requests: PENDING+ACKNOWLEDGED, oldest-first, BRING_BILL and terminal and other-restaurant excluded, table derived", async () => {
    // Biryani House actionable rows (expected in queue):
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");
    seedRequest(REQ_CUTLERY_ACK, REST_ID, "CUTLERY", "ACKNOWLEDGED", "2026-08-24T10:02:00.000Z");
    seedRequest(
      REQ_OTHER_PENDING,
      REST_ID,
      "OTHER",
      "PENDING",
      "2026-08-24T10:03:00.000Z",
      "need a refill please",
      { tableId: "t2", tableLabel: "T2", sessionId: "s2" },
    );
    // Excluded rows under the same restaurant:
    seedRequest(REQ_BRING_BILL, REST_ID, "BRING_BILL", "PENDING", "2026-08-24T09:00:00.000Z");
    seedRequest(REQ_COMPLETED, REST_ID, "WATER", "COMPLETED", "2026-08-24T09:30:00.000Z");
    seedRequest(REQ_CANCELLED, REST_ID, "CALL_STAFF", "CANCELLED", "2026-08-24T10:04:00.000Z");
    // Other-restaurant row (excluded):
    seedRequest(
      REQ_GREEN_PENDING,
      GREEN_BOWL_ID,
      "WATER",
      "PENDING",
      "2026-08-24T09:00:00.000Z",
      null,
      { tableId: "tg1", tableLabel: "G1", sessionId: "sg1" },
    );

    const res = await request(app)
      .get(`/api/vendor/dine-in/service-requests?restaurant_id=${REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.error).toBeNull();
    const queue = res.body.data as Array<{
      id: string;
      session_id: string;
      restaurant_id: string;
      request_type: string;
      status: string;
      note: string | null;
      created_at: string;
      table: { id: string; label: string };
    }>;

    // Order + membership exactly (oldest-first, no BRING_BILL/terminal/cross).
    expect(queue.map((r) => r.id)).toEqual([
      REQ_WATER_PENDING,
      REQ_CUTLERY_ACK,
      REQ_OTHER_PENDING,
    ]);
    expect(queue.map((r) => r.status)).toEqual([
      "PENDING",
      "ACKNOWLEDGED",
      "PENDING",
    ]);
    expect(queue.map((r) => r.request_type)).toEqual(["WATER", "CUTLERY", "OTHER"]);

    // Derived table identity per row.
    expect(queue[0]!.table).toEqual({ id: "t1", label: "T1" });
    expect(queue[1]!.table).toEqual({ id: "t1", label: "T1" });
    expect(queue[2]!.table).toEqual({ id: "t2", label: "T2" });

    // OTHER note is preserved for the staff to read.
    expect(queue[2]!.note).toBe("need a refill please");

    // Excluded ids never appear.
    const ids = queue.map((r) => r.id);
    expect(ids).not.toContain(REQ_BRING_BILL);
    expect(ids).not.toContain(REQ_COMPLETED);
    expect(ids).not.toContain(REQ_CANCELLED);
    expect(ids).not.toContain(REQ_GREEN_PENDING);
  });

  it("5. scoped staff and ADMIN can read the queue; unrelated vendor cannot", async () => {
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");

    // Green Bowl owner has no access to Biryani House -> FORBIDDEN.
    await request(app)
      .get(`/api/vendor/dine-in/service-requests?restaurant_id=${REST_ID}`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);

    // Scoped Biryani House staff passes.
    sharedUserRoleRepo._seed({
      id: "ur-sr-staff-1",
      user_id: STAFF_ID,
      scope_type: "restaurant",
      scope_id: REST_ID,
      role: "VENDOR_STAFF",
      created_at: "2026-08-24T00:00:00.000Z",
    });
    const staffRes = await request(app)
      .get(`/api/vendor/dine-in/service-requests?restaurant_id=${REST_ID}`)
      .set(authHeaders(STAFF_ID, "VENDOR_STAFF"))
      .expect(200);
    expect(staffRes.body.data.map((r: { id: string }) => r.id)).toEqual([
      REQ_WATER_PENDING,
    ]);

    // ADMIN bypasses ownership (platform oversight).
    const adminRes = await request(app)
      .get(`/api/vendor/dine-in/service-requests?restaurant_id=${REST_ID}`)
      .set(authHeaders(ADMIN_ID, "ADMIN"))
      .expect(200);
    expect(adminRes.body.data.map((r: { id: string }) => r.id)).toEqual([
      REQ_WATER_PENDING,
    ]);
  });

  // ---- acknowledge --------------------------------------------------------

  it("6. owner acknowledges PENDING -> ACKNOWLEDGED with server-authoritative audit", async () => {
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(res.body.data.request.id).toBe(REQ_WATER_PENDING);
    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
    expect(res.body.data.request.acknowledged_by).toBe(OWNER_ID);
    expect(typeof res.body.data.request.acknowledged_at).toBe("string");
  });

  it("7. acknowledge body fields are NOT authoritative (server sets audit)", async () => {
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({
        acknowledged_by: "attacker-id",
        acknowledged_at: "2099-01-01T00:00:00.000Z",
        status: "COMPLETED",
        request_type: "BRING_BILL",
      })
      .expect(200);
    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
    expect(res.body.data.request.request_type).toBe("WATER");
    expect(res.body.data.request.acknowledged_by).toBe(OWNER_ID);
    expect(res.body.data.request.acknowledged_at).not.toBe("2099-01-01T00:00:00.000Z");
    expect(typeof res.body.data.request.acknowledged_at).toBe("string");
  });

  it("8. ack of an already-ACKNOWLEDGED request stays idempotent (frozen retry)", async () => {
    seedRequest(REQ_CUTLERY_ACK, REST_ID, "CUTLERY", "ACKNOWLEDGED", "2026-08-24T10:02:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_CUTLERY_ACK}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
  });

  // ---- complete -----------------------------------------------------------

  it("9. complete of an ACKNOWLEDGED request -> COMPLETED with server-authoritative audit", async () => {
    seedRequest(REQ_CUTLERY_ACK, REST_ID, "CUTLERY", "ACKNOWLEDGED", "2026-08-24T10:02:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_CUTLERY_ACK}/complete`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(res.body.data.request.id).toBe(REQ_CUTLERY_ACK);
    expect(res.body.data.request.status).toBe("COMPLETED");
    expect(res.body.data.request.completed_by).toBe(OWNER_ID);
    expect(typeof res.body.data.request.completed_at).toBe("string");
  });

  it("10. complete body fields are NOT authoritative (server sets audit)", async () => {
    seedRequest(REQ_CUTLERY_ACK, REST_ID, "CUTLERY", "ACKNOWLEDGED", "2026-08-24T10:02:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_CUTLERY_ACK}/complete`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .send({
        completed_by: "attacker-id",
        completed_at: "2099-01-01T00:00:00.000Z",
        status: "CANCELLED",
      })
      .expect(200);
    expect(res.body.data.request.status).toBe("COMPLETED");
    expect(res.body.data.request.completed_by).toBe(OWNER_ID);
    expect(res.body.data.request.completed_at).not.toBe("2099-01-01T00:00:00.000Z");
    expect(typeof res.body.data.request.completed_at).toBe("string");
  });

  it("11. PENDING cannot be completed directly (existing frozen 409, no silent auto-ack)", async () => {
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/complete`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(res.body.error.code).toBe("INVALID_SERVICE_REQUEST_TRANSITION");
    expect(await currentRequestStatus(REQ_WATER_PENDING)).toBe("PENDING");
  });

  it("12. owner runs the full acknowledge -> complete lifecycle", async () => {
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");
    const ack = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(ack.body.data.request.status).toBe("ACKNOWLEDGED");

    const done = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/complete`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(done.body.data.request.status).toBe("COMPLETED");
    expect(await currentRequestStatus(REQ_WATER_PENDING)).toBe("COMPLETED");
  });

  // ---- authorization + guards --------------------------------------------

  it("13. scoped staff can acknowledge and complete (audit = staff caller)", async () => {
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");
    sharedUserRoleRepo._seed({
      id: "ur-sr-staff-2",
      user_id: STAFF_ID,
      scope_type: "restaurant",
      scope_id: REST_ID,
      role: "VENDOR_STAFF",
      created_at: "2026-08-24T00:00:00.000Z",
    });
    const ack = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/acknowledge`)
      .set(authHeaders(STAFF_ID, "VENDOR_STAFF"))
      .expect(200);
    expect(ack.body.data.request.acknowledged_by).toBe(STAFF_ID);

    const done = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/complete`)
      .set(authHeaders(STAFF_ID, "VENDOR_STAFF"))
      .expect(200);
    expect(done.body.data.request.completed_by).toBe(STAFF_ID);
    expect(done.body.data.request.status).toBe("COMPLETED");
  });

  it("14. cross-restaurant mutation is ZERO (403 before any service call)", async () => {
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");
    const ack = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/acknowledge`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(ack.body.error.code).toBe("FORBIDDEN");
    expect(await currentRequestStatus(REQ_WATER_PENDING)).toBe("PENDING");

    const done = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/complete`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(done.body.error.code).toBe("FORBIDDEN");
    expect(await currentRequestStatus(REQ_WATER_PENDING)).toBe("PENDING");
  });

  it("15. client cannot spoof ownership via body/query restaurant_id", async () => {
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(
        `/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/acknowledge?restaurant_id=${GREEN_BOWL_ID}`,
      )
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .send({ restaurant_id: GREEN_BOWL_ID })
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(await currentRequestStatus(REQ_WATER_PENDING)).toBe("PENDING");
  });

  it("16. BRING_BILL cannot be acknowledged or completed on the vendor surface (409 boundary)", async () => {
    seedRequest(REQ_BRING_BILL, REST_ID, "BRING_BILL", "PENDING", "2026-08-24T09:00:00.000Z");
    const ack = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_BRING_BILL}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(ack.body.error.code).toBe("BRING_BILL_MANAGED_BY_BILL_FLOW");
    expect(await currentRequestStatus(REQ_BRING_BILL)).toBe("PENDING");

    const done = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_BRING_BILL}/complete`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(409);
    expect(done.body.error.code).toBe("BRING_BILL_MANAGED_BY_BILL_FLOW");
    expect(await currentRequestStatus(REQ_BRING_BILL)).toBe("PENDING");
  });

  it("17. cross-restaurant BRING_BILL is FORBIDDEN before the BRING_BILL boundary (no 409 type/existence leak)", async () => {
    seedRequest(REQ_BRING_BILL, REST_ID, "BRING_BILL", "PENDING", "2026-08-24T09:00:00.000Z");
    const ack = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_BRING_BILL}/acknowledge`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(ack.body.error.code).toBe("FORBIDDEN");
    expect(ack.body.error.code).not.toBe("BRING_BILL_MANAGED_BY_BILL_FLOW");
    expect(await currentRequestStatus(REQ_BRING_BILL)).toBe("PENDING");

    const done = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_BRING_BILL}/complete`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
    expect(done.body.error.code).toBe("FORBIDDEN");
    expect(done.body.error.code).not.toBe("BRING_BILL_MANAGED_BY_BILL_FLOW");
    expect(await currentRequestStatus(REQ_BRING_BILL)).toBe("PENDING");
  });

  it("18. ADMIN bypasses restaurant ownership (platform oversight)", async () => {
    seedRequest(REQ_WATER_PENDING, REST_ID, "WATER", "PENDING", "2026-08-24T10:01:00.000Z");
    const res = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_WATER_PENDING}/acknowledge`)
      .set(authHeaders(ADMIN_ID, "ADMIN"))
      .expect(200);
    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
  });

  // ---- malformed / missing -----------------------------------------------

  it("19. non-UUID requestId is a VALIDATION_ERROR 400 (ack + complete)", async () => {
    const ack = await request(app)
      .post("/api/vendor/dine-in/service-requests/not-a-uuid/acknowledge")
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
    expect(ack.body.error.code).toBe("VALIDATION_ERROR");

    const done = await request(app)
      .post("/api/vendor/dine-in/service-requests/not-a-uuid/complete")
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
    expect(done.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("20. unknown request -> SERVICE_REQUEST_NOT_FOUND 404 (ack + complete)", async () => {
    const ack = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_UNKNOWN}/acknowledge`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(404);
    expect(ack.body.error.code).toBe("SERVICE_REQUEST_NOT_FOUND");

    const done = await request(app)
      .post(`/api/vendor/dine-in/service-requests/${REQ_UNKNOWN}/complete`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(404);
    expect(done.body.error.code).toBe("SERVICE_REQUEST_NOT_FOUND");
  });
});
