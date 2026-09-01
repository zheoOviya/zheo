import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { jwtService } from "../services/jwt";
import type { RestaurantEligibilityDTO, RestaurantTableDTO } from "../repositories/dineInContracts";
import { getDineInTransactionPort, resetDineInState } from "../repositories/dineInComposition";
import { resetCatalogRepository } from "../routes/catalog";
import { resetRedisForTests } from "../lib/redis";

// ------------------------------------------------------------
// H5.1 App mount smoke coverage.
//
// The accepted dineInRouter is mounted at /api/v1/dine-in in app.ts.
// Minimal mount proof only — business-flow integration is H5.2+.
//   A. a known Dine-In route reaches the router (401 from its authenticate
//      middleware proves the mount, not an app-level 404)
//   B. an unknown Dine-In path still falls through to the app 404
// ------------------------------------------------------------

const TEST_USER_ID = "u00000000-0000-4000-8000-000000000001";
const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001"; // Chicken Biryani Rs 220

function authToken(userId = TEST_USER_ID): string {
  return jwtService.signAccessToken({
    sub: userId,
    phone: "+919876543210",
    role: "CONSUMER",
    device_fingerprint: "fp_test_device_abc1234",
  });
}

function authHeaders(userId?: string) {
  return { Authorization: `Bearer ${authToken(userId)}` };
}

function sharedRepos() {
  return (getDineInTransactionPort() as unknown as {
    repos: {
      restaurantTables: { _seed(t: RestaurantTableDTO): RestaurantTableDTO };
      restaurantEligibility: { _seed(d: RestaurantEligibilityDTO): RestaurantEligibilityDTO };
      sessionBills: { getBySessionId(id: string): Promise<unknown> };
      serviceRequests: { getBySession(sessionId: string): Promise<unknown[]> };
    };
  }).repos;
}

function seedTableAndEligibility() {
  sharedRepos().restaurantTables._seed({
    id: "table-1",
    restaurant_id: RESTAURANT_ID,
    zone_id: null,
    label: "T1",
    table_token: "token-abc",
    seat_count: 4,
    is_active: true,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  });
  sharedRepos().restaurantEligibility._seed({ id: RESTAURANT_ID, is_active: true });
}

describe("Dine-In router app mount (H5.1)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    app = createApp();
  });

  it("A. POST /api/v1/dine-in/sessions reaches dineInRouter, not app 404", async () => {
    // No Authorization header: the router's authenticate middleware answers
    // 401, which is only possible if the mount reached the dine-in router.
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .send({ table_token: "token-abc" })
      .expect(401);

    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("B. unknown /api/v1/dine-in path still falls through to the app 404", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/does-not-exist")
      .send({})
      .expect(404);

    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

// ------------------------------------------------------------
// H5.2 Mounted app auth / middleware smoke coverage.
//
// Proves the mounted /api/v1/dine-in surface receives the existing global
// middleware (correlation, apiLimiter, notFound, errorHandler) and the
// per-route authenticate/error handling — with NO business-flow integration.
// ------------------------------------------------------------

describe("Dine-In mounted app middleware/auth smoke (H5.2)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetDineInState();
    app = createApp();
  });

  it("A. mounted session route unauthenticated -> UNAUTHORIZED 401", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .send({ table_token: "token-abc" })
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("B. another mounted Dine-In command unauthenticated -> UNAUTHORIZED 401", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .send({ session_id: "11111111-1111-4111-8111-111111111111", request_type: "WATER" })
      .expect(401);

    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("C. authenticated identity reaches the service boundary as caller_user_id", async () => {
    seedTableAndEligibility();
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .send({ table_token: "token-abc" })
      .expect(200);

    expect(res.body.data.session.owner_user_id).toBe(TEST_USER_ID);
  });

  it("D. correlation middleware runs on the mounted surface", async () => {
    // Unauthenticated: authenticate answers 401, but the correlation middleware
    // already ran and echoed the inbound header — proving the global middleware
    // is present on the mounted path.
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set("x-correlation-id", "inbound-app-corr")
      .send({ table_token: "token-abc" })
      .expect(401);

    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(res.headers["x-correlation-id"]).toBe("inbound-app-corr");
  });

  it("E. body caller_user_id/correlation_id cannot override locals-derived values", async () => {
    seedTableAndEligibility();
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .set("x-correlation-id", "inbound-app-corr")
      .send({
        table_token: "token-abc",
        caller_user_id: "attacker-id",
        correlation_id: "attacker-corr",
      })
      .expect(200);

    expect(res.body.data.session.owner_user_id).toBe(TEST_USER_ID);
    expect(res.headers["x-correlation-id"]).toBe("inbound-app-corr");
    expect(res.headers["x-correlation-id"]).not.toBe("attacker-corr");
  });

  it("F. transport validation error -> VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({})
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("G. service AppError preserved through the central error handler", async () => {
    // Authenticated command on a non-existent session -> SESSION_NOT_FOUND 404.
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({ session_id: "11111111-1111-4111-8111-111111111111", request_type: "WATER" })
      .expect(404);

    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("H. unknown mounted Dine-In path -> NOT_FOUND 404", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/does-not-exist")
      .set(authHeaders())
      .send({})
      .expect(404);

    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

// ------------------------------------------------------------
// H5.3 Mounted session -> order shared-state HTTP flow.
//
// Core invariant: the mounted POST /orders accepts the session id created by
// the mounted POST /sessions, proving both routes see the same H2.1 runtime
// universe (one shared Dine-In transaction port + one shared catalog repo).
// No direct service mutation, no manual state bridge.
// ------------------------------------------------------------

async function openSessionViaHttp(app: Express): Promise<string> {
  const res = await request(app)
    .post("/api/v1/dine-in/sessions")
    .set(authHeaders(TEST_USER_ID))
    .send({ table_token: "token-abc" })
    .expect(200);
  return res.body.data.session.id as string;
}

describe("Dine-In mounted session-to-order shared state (H5.3)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetDineInState();
    resetCatalogRepository();
    seedTableAndEligibility();
    app = createApp();
  });

  it("A. HTTP session then HTTP placeOrder succeed in the same runtime state", async () => {
    const sessionId = await openSessionViaHttp(app);

    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders(TEST_USER_ID))
      .send({
        session_id: sessionId,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 2 }],
      })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.order.status).toBe("PLACED");
  });

  it("B. order links to the HTTP-created session id", async () => {
    const sessionId = await openSessionViaHttp(app);

    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders(TEST_USER_ID))
      .send({
        session_id: sessionId,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
      })
      .expect(201);

    expect(res.body.data.order.session_id).toBe(sessionId);
    expect(res.body.data.order.placed_by).toBe(TEST_USER_ID);
  });

  it("C. server-authoritative catalog price survives client monetary junk", async () => {
    const sessionId = await openSessionViaHttp(app);

    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders(TEST_USER_ID))
      .send({
        session_id: sessionId,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 2,
            base_price: 1,
            unit_price: 5,
            item_subtotal: 0,
            total_amount: 0,
          },
        ],
      })
      .expect(201);

    // Catalog price is Rs 220; server computes 2 x 220 = 440 + 5% GST = 462.
    expect(res.body.data.order.items[0].item_subtotal).toBe(440);
    expect(res.body.data.order.total_amount).toBe(462);
  });

  it("D. nonexistent session preserves the domain error through the mount", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders(TEST_USER_ID))
      .send({
        session_id: "99999999-9999-4999-8999-999999999999",
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
      })
      .expect(404);

    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
  });
});

// ------------------------------------------------------------
// H5.4 Mounted service-request lifecycle HTTP flow.
//
// The SAME request id returned by the mounted POST /service-requests traverses
// PENDING -> ACKNOWLEDGED -> COMPLETED through mounted HTTP commands with NO
// direct service/repo mutation between steps — one shared H2.1 runtime universe.
// ------------------------------------------------------------

describe("Dine-In mounted service-request lifecycle (H5.4)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetDineInState();
    resetCatalogRepository();
    seedTableAndEligibility();
    app = createApp();
  });

  async function openSession(): Promise<string> {
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .send({ table_token: "token-abc" })
      .expect(200);
    return res.body.data.session.id as string;
  }

  async function createRequest(sessionId: string, body: Record<string, unknown>): Promise<string> {
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: sessionId, ...body })
      .expect(201);
    return res.body.data.request.id as string;
  }

  it("A. HTTP session then request create -> PENDING", async () => {
    const sessionId = await openSession();

    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: sessionId, request_type: "WATER" })
      .expect(201);

    expect(res.body.data.request.session_id).toBe(sessionId);
    expect(res.body.data.request.request_type).toBe("WATER");
    expect(res.body.data.request.status).toBe("PENDING");
  });

  it("B. acknowledge the HTTP-created request -> ACKNOWLEDGED", async () => {
    const sessionId = await openSession();
    const requestId = await createRequest(sessionId, { request_type: "WATER" });

    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/acknowledge`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);

    expect(res.body.data.request.id).toBe(requestId);
    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
  });

  it("C. complete the same request -> COMPLETED", async () => {
    const sessionId = await openSession();
    const requestId = await createRequest(sessionId, { request_type: "WATER" });

    await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/acknowledge`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);

    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/complete`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);

    expect(res.body.data.request.id).toBe(requestId);
    expect(res.body.data.request.status).toBe("COMPLETED");
  });

  it("D. the same request id flows across all lifecycle commands", async () => {
    const sessionId = await openSession();
    const requestId = await createRequest(sessionId, { request_type: "WATER" });

    const ack = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/acknowledge`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);

    const complete = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/complete`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);

    expect(ack.body.data.request.id).toBe(requestId);
    expect(complete.body.data.request.id).toBe(requestId);
    expect(complete.body.data.request.session_id).toBe(sessionId);
  });

  it("E. audit fields are server-owned (client cannot inject)", async () => {
    const sessionId = await openSession();
    const requestId = await createRequest(sessionId, { request_type: "WATER" });

    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/acknowledge`)
      .set(authHeaders(TEST_USER_ID))
      .send({
        acknowledged_by: "attacker",
        acknowledged_at: "2099-01-01T00:00:00.000Z",
      })
      .expect(200);

    expect(res.body.data.request.acknowledged_by).toBe(TEST_USER_ID);
    expect(res.body.data.request.acknowledged_at).not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("F. completing a still-PENDING request is a service-owned 409", async () => {
    const sessionId = await openSession();
    const requestId = await createRequest(sessionId, { request_type: "WATER" });

    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/complete`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(409);

    expect(res.body.error.code).toBe("INVALID_SERVICE_REQUEST_TRANSITION");
  });

  it("G. OTHER request with a valid note -> 201", async () => {
    const sessionId = await openSession();

    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: sessionId, request_type: "OTHER", note: "  Please clean table  " })
      .expect(201);

    expect(res.body.data.request.request_type).toBe("OTHER");
    expect(res.body.data.request.note).toBe("Please clean table");
  });
});

// ------------------------------------------------------------
// H5.5 Mounted billing + BRING_BILL HTTP flow.
//
// BRING_BILL is created ONLY by requestBill (billing flow). The billing-created
// request acknowledges/completes over HTTP; generic create is blocked at the
// transport and generic cancel is blocked by the service-owned 409 boundary.
// NO final-order cancellation, NO D-PAY/payment behavior.
// ------------------------------------------------------------

describe("Dine-In mounted billing/BRING_BILL flow (H5.5)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetDineInState();
    resetCatalogRepository();
    seedTableAndEligibility();
    app = createApp();
  });

  async function openSession(): Promise<string> {
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .send({ table_token: "token-abc" })
      .expect(200);
    return res.body.data.session.id as string;
  }

  async function placeOrder(sessionId: string): Promise<void> {
    await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: sessionId, items: [{ menu_item_id: MENU_ITEM_1, quantity: 2 }] })
      .expect(201);
  }

  async function requestBill(sessionId: string) {
    const res = await request(app)
      .post(`/api/v1/dine-in/sessions/${sessionId}/bill`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);
    return res.body.data;
  }

  async function openSessionOrderAndBill() {
    const sessionId = await openSession();
    await placeOrder(sessionId);
    return await requestBill(sessionId);
  }

  it("A. session -> order -> requestBill succeeds", async () => {
    const data = await openSessionOrderAndBill();

    expect(data.session.status).toBe("BILL_REQUESTED");
    expect(data.bill).not.toBeNull();
    expect(data.bill.session_id).toBe(data.session.id);
    expect(data.bringBillRequest).not.toBeNull();
  });

  it("B. bill artifact arithmetic is coherent", async () => {
    const data = await openSessionOrderAndBill();

    // 2 x Rs 220 = 440 food subtotal, 5% GST = 22, packaging 0, total 462.
    expect(data.bill.food_subtotal).toBe(440);
    expect(data.bill.gst_food).toBe(22);
    expect(data.bill.packaging_fee).toBe(0);
    expect(data.bill.gst_packaging).toBe(0);
    expect(data.bill.total_amount).toBe(462);
  });

  it("C. billing-created BRING_BILL is returned as PENDING", async () => {
    const data = await openSessionOrderAndBill();

    expect(data.bringBillRequest.request_type).toBe("BRING_BILL");
    expect(data.bringBillRequest.session_id).toBe(data.session.id);
    expect(data.bringBillRequest.status).toBe("PENDING");
  });

  it("D. requestBill retry returns the same bill and BRING_BILL ids", async () => {
    const sessionId = await openSession();
    await placeOrder(sessionId);
    const first = await requestBill(sessionId);
    const second = await requestBill(sessionId);

    expect(second.bill.id).toBe(first.bill.id);
    expect(second.bringBillRequest.id).toBe(first.bringBillRequest.id);
    expect(second.bill.total_amount).toBe(first.bill.total_amount);
    expect(second.bill.food_subtotal).toBe(first.bill.food_subtotal);
  });

  it("E. generic BRING_BILL create is blocked at the transport (400)", async () => {
    const sessionId = await openSession();
    await placeOrder(sessionId);

    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: sessionId, request_type: "BRING_BILL" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("F. billing-created BRING_BILL acknowledge -> 200", async () => {
    const data = await openSessionOrderAndBill();
    const requestId = data.bringBillRequest.id;

    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/acknowledge`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);

    expect(res.body.data.request.id).toBe(requestId);
    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
  });

  it("G. billing-created BRING_BILL complete -> 200", async () => {
    const data = await openSessionOrderAndBill();
    const requestId = data.bringBillRequest.id;

    await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/acknowledge`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);

    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/complete`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);

    expect(res.body.data.request.id).toBe(requestId);
    expect(res.body.data.request.status).toBe("COMPLETED");
  });

  it("H. billing-created BRING_BILL generic cancel -> 409 service-owned block", async () => {
    const data = await openSessionOrderAndBill();
    const requestId = data.bringBillRequest.id;

    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/cancel`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(409);

    expect(res.body.error.code).toBe("BRING_BILL_MANAGED_BY_BILL_FLOW");
  });

  it("I. no D-PAY/payment behavior is pulled in", async () => {
    const data = await openSessionOrderAndBill();

    // Session stays BILL_REQUESTED — no PAYMENT_PENDING transition, no close.
    expect(data.session.status).toBe("BILL_REQUESTED");
    expect(data.session.payment_pending_at).toBeNull();
    expect(data.session.closed_at).toBeNull();
    // The frozen bill carries no payment fields.
    expect(data.bill).not.toHaveProperty("payment_status");
    expect(data.bill).not.toHaveProperty("paid_at");
  });
});

// ------------------------------------------------------------
// H5.6 Mounted final-order cancel -> ACTIVE->OPEN -> bill 400 flow.
//
// Cancelling the ONLY non-CANCELLED billable order reopens the ACTIVE session
// (ACTIVE->OPEN compensation). The externally observable proof: a subsequent
// requestBill returns SESSION_NOT_BILLABLE 400 and creates no bill/BRING_BILL
// artifact. Cancel retry is idempotent with the original audit timestamp kept.
// ------------------------------------------------------------

describe("Dine-In mounted final-cancel compensation (H5.6)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetDineInState();
    resetCatalogRepository();
    seedTableAndEligibility();
    app = createApp();
  });

  async function openSession(): Promise<string> {
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .send({ table_token: "token-abc" })
      .expect(200);
    return res.body.data.session.id as string;
  }

  async function placeOrder(sessionId: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: sessionId, items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }] })
      .expect(201);
    return res.body.data.order.id as string;
  }

  async function cancelOrder(orderId: string) {
    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/cancel`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(200);
    return res.body.data.order;
  }

  it("A. final order cancel -> requestBill returns 400 SESSION_NOT_BILLABLE", async () => {
    const sessionId = await openSession();
    const orderId = await placeOrder(sessionId);
    await cancelOrder(orderId);

    const res = await request(app)
      .post(`/api/v1/dine-in/sessions/${sessionId}/bill`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(400);

    expect(res.body.error.code).toBe("SESSION_NOT_BILLABLE");
  });

  it("B. cancelled order audit metadata is server-owned", async () => {
    const sessionId = await openSession();
    const orderId = await placeOrder(sessionId);

    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/cancel`)
      .set(authHeaders(TEST_USER_ID))
      .send({ cancelled_by: "attacker", cancelled_at: "2099-01-01T00:00:00.000Z" })
      .expect(200);

    expect(res.body.data.order.id).toBe(orderId);
    expect(res.body.data.order.status).toBe("CANCELLED");
    expect(res.body.data.order.cancelled_by).toBe(TEST_USER_ID);
    expect(res.body.data.order.cancelled_at).not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("C. no bill/BRING_BILL artifact after the cancel-first flow", async () => {
    const sessionId = await openSession();
    const orderId = await placeOrder(sessionId);
    await cancelOrder(orderId);

    await request(app)
      .post(`/api/v1/dine-in/sessions/${sessionId}/bill`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(400);

    // Read-only inspection of the shared repos after the HTTP flow proves the
    // failed requestBill created no bill and no BRING_BILL artifact.
    const repos = sharedRepos();
    const bills = repos.sessionBills as unknown as { getBySessionId(id: string): Promise<unknown> };
    const requests = repos.serviceRequests as unknown as {
      getBySession(sessionId: string): Promise<unknown[]>;
    };
    expect(await bills.getBySessionId(sessionId)).toBeNull();
    expect(await requests.getBySession(sessionId)).toEqual([]);
  });

  it("D. cancel retry is idempotent and preserves the audit timestamp", async () => {
    const sessionId = await openSession();
    const orderId = await placeOrder(sessionId);
    const first = await cancelOrder(orderId);
    const second = await cancelOrder(orderId);

    expect(second.id).toBe(orderId);
    expect(second.status).toBe("CANCELLED");
    expect(second.cancelled_by).toBe(TEST_USER_ID);
    expect(second.cancelled_at).toBe(first.cancelled_at);
  });
});

// ------------------------------------------------------------
// H5.7 Mounted error + client-authority boundary integration.
//
// Representative proofs only — the full domain matrix lives in the H1-H4
// unit/service suites. Pins that mounted-app errors preserve status/code, and
// client-supplied caller/correlation/monetary/audit values never gain authority.
// ------------------------------------------------------------

describe("Dine-In mounted error and client-authority boundaries (H5.7)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetDineInState();
    resetCatalogRepository();
    seedTableAndEligibility();
    app = createApp();
  });

  async function openSession(tableToken = "token-abc"): Promise<string> {
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .send({ table_token: tableToken })
      .expect(200);
    return res.body.data.session.id as string;
  }

  async function placeOrder(sessionId: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: sessionId, items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }] })
      .expect(201);
    return res.body.data.order.id as string;
  }

  it("A. TABLE_NOT_FOUND -> 404 through the mount", async () => {
    // Table token for a table that does not exist (fixture only seeds "token-abc").
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .send({ table_token: "no-such-table" })
      .expect(404);

    expect(res.body.error.code).toBe("TABLE_NOT_FOUND");
  });

  it("B. ORDER_NOT_FOUND -> 404 through the mount", async () => {
    const res = await request(app)
      .post(
        "/api/v1/dine-in/orders/99999999-9999-4999-8999-999999999999/cancel",
      )
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(404);

    expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
  });

  it("C. ORDER_NOT_CANCELLABLE -> 409 through the mount", async () => {
    const sessionId = await openSession();
    const orderId = await placeOrder(sessionId);

    // Advance to READY_TO_SERVE, which is not a cancellable stage.
    await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/advance`)
      .set(authHeaders(TEST_USER_ID))
      .send({ target_status: "PREPARING" })
      .expect(200);
    await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/advance`)
      .set(authHeaders(TEST_USER_ID))
      .send({ target_status: "READY_TO_SERVE" })
      .expect(200);

    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/cancel`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(409);

    expect(res.body.error.code).toBe("ORDER_NOT_CANCELLABLE");
  });

  it("D. SERVICE_REQUEST_NOT_FOUND -> 404 through the mount", async () => {
    const res = await request(app)
      .post(
        "/api/v1/dine-in/service-requests/99999999-9999-4999-8999-999999999999/acknowledge",
      )
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(404);

    expect(res.body.error.code).toBe("SERVICE_REQUEST_NOT_FOUND");
  });

  it("E. malformed transport stays VALIDATION_ERROR 400 (no 422)", async () => {
    const badUuid = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: "not-a-uuid", request_type: "WATER" })
      .expect(400);
    expect(badUuid.body.error.code).toBe("VALIDATION_ERROR");

    const malformedBody = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .send({})
      .expect(400);
    expect(malformedBody.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("F. caller/correlation body override is blocked", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .set("x-correlation-id", "inbound-h57-corr")
      .send({
        table_token: "token-abc",
        caller_user_id: "attacker-id",
        correlation_id: "attacker-corr",
      })
      .expect(200);

    expect(res.body.data.session.owner_user_id).toBe(TEST_USER_ID);
    expect(res.headers["x-correlation-id"]).toBe("inbound-h57-corr");
    expect(res.headers["x-correlation-id"]).not.toBe("attacker-corr");
  });

  it("G. client monetary fields are non-authoritative", async () => {
    const sessionId = await openSession();

    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders(TEST_USER_ID))
      .send({
        session_id: sessionId,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            base_price: 1,
            unit_price: 5,
            item_subtotal: 0,
            total_amount: 0,
          },
        ],
      })
      .expect(201);

    // Catalog price Rs 220 wins: 1 x 220 = 220 + 5% GST = 231.
    expect(res.body.data.order.items[0].item_subtotal).toBe(220);
    expect(res.body.data.order.total_amount).toBe(231);
  });

  it("H. order audit fields are non-authoritative", async () => {
    const sessionId = await openSession();
    const orderId = await placeOrder(sessionId);

    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/cancel`)
      .set(authHeaders(TEST_USER_ID))
      .send({ cancelled_by: "attacker", cancelled_at: "2099-01-01T00:00:00.000Z" })
      .expect(200);

    expect(res.body.data.order.cancelled_by).toBe(TEST_USER_ID);
    expect(res.body.data.order.cancelled_at).not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("I. request audit fields are non-authoritative", async () => {
    const sessionId = await openSession();

    const created = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: sessionId, request_type: "WATER" })
      .expect(201);
    const requestId = created.body.data.request.id;

    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${requestId}/acknowledge`)
      .set(authHeaders(TEST_USER_ID))
      .send({ acknowledged_by: "attacker", acknowledged_at: "2099-01-01T00:00:00.000Z" })
      .expect(200);

    expect(res.body.data.request.acknowledged_by).toBe(TEST_USER_ID);
    expect(res.body.data.request.acknowledged_at).not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("J. generic BRING_BILL create remains blocked at the transport", async () => {
    const sessionId = await openSession();

    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders(TEST_USER_ID))
      .send({ session_id: sessionId, request_type: "BRING_BILL" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
