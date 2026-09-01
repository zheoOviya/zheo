import type { Express } from "express";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { correlationIdMiddleware } from "../lib/correlation";
import { errorHandler, notFoundHandler } from "../middleware/errorHandler";
import { DineInOrderService } from "../services/dineInOrder";
import { DiningSessionService } from "../services/dineInSession";
import type { DineInEventFactEmitter } from "../services/dineInEventEmitter";
import { jwtService } from "../services/jwt";
import {
  getDineInTransactionPort,
  resetDineInState,
} from "../repositories/dineInComposition";
import type { CatalogRepository, MenuItemDTO } from "../repositories/catalogRepository";
import type {
  DiningSessionDTO,
  DineInTransactionRepos,
  RestaurantEligibilityDTO,
  RestaurantTableDTO,
  ServiceRequestDTO,
  SessionBillDTO,
} from "../repositories/dineInContracts";
import { dineInRouter } from "./dineIn";
import { resetCatalogRepository } from "./catalog";

// ------------------------------------------------------------
// H2.2 Dine-In session HTTP routes.
//
// The router is mounted in this test harness at /api/v1/dine-in with the
// same relevant middleware stack as app.ts (express.json, correlation,
// router, notFound, errorHandler). The real app-level mount remains H5.
// All tests run against the H2.1 shared composition (getDineInTransactionPort
// singleton) so route + service + test-constructed services share ONE repo
// universe.
// ------------------------------------------------------------

const TEST_USER_ID = "u00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "u00000000-0000-4000-8000-000000000002";
const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID_2 = "22222222-2222-4222-8222-222222222222";
const BILL_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001"; // Chicken Biryani Rs 220

const noopEmitter: DineInEventFactEmitter = async () => {};

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

function makeTable(overrides: Partial<RestaurantTableDTO> = {}): RestaurantTableDTO {
  return {
    id: "table-1",
    restaurant_id: RESTAURANT_ID,
    zone_id: null,
    label: "T1",
    table_token: "token-abc",
    seat_count: 4,
    is_active: true,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function makeEligibility(): RestaurantEligibilityDTO {
  return { id: RESTAURANT_ID, is_active: true };
}

function makeMenuItem(overrides: Partial<MenuItemDTO> = {}): MenuItemDTO {
  return {
    id: "item-1",
    restaurant_id: RESTAURANT_ID,
    name: "Paneer Tikka",
    price: 100,
    description: null,
    dietary_tags: {},
    customizations: [],
    image_url: null,
    pos_item_id: null,
    is_available: true,
    spice_level: 3,
    ...overrides,
  };
}

function makeCatalog(items: Record<string, MenuItemDTO | null> = {}) {
  const getMenuItemById = vi.fn(
    async (id: string) => (id in items ? items[id] : null),
  );
  return {
    catalog: { getMenuItemById } as unknown as CatalogRepository,
    getMenuItemById,
  };
}

function makeSession(
  overrides: Partial<DiningSessionDTO> = {},
): DiningSessionDTO {
  return {
    id: SESSION_ID,
    restaurant_id: RESTAURANT_ID,
    table_id: "table-1",
    owner_user_id: TEST_USER_ID,
    status: "OPEN",
    bill_requested_at: null,
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function makeBill(overrides: Partial<SessionBillDTO> = {}): SessionBillDTO {
  return {
    id: BILL_ID,
    session_id: SESSION_ID,
    restaurant_id: RESTAURANT_ID,
    food_subtotal: 200,
    packaging_fee: 0,
    gst_food: 10,
    gst_packaging: 0,
    total_amount: 210,
    frozen_at: "2026-08-24T00:00:00.000Z",
    created_at: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function sharedRepos(): DineInTransactionRepos {
  return (getDineInTransactionPort() as unknown as {
    repos: DineInTransactionRepos;
  }).repos;
}

function seedTableAndEligibility() {
  const repos = sharedRepos();
  (repos.restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  })._seed(makeTable());
  (repos.restaurantEligibility as unknown as {
    _seed(d: RestaurantEligibilityDTO): RestaurantEligibilityDTO;
  })._seed(makeEligibility());
}

// Resolvable-table test surface: the shared MemoryRestaurantTableRepository
// (same instance the resolve route wires) exposes a seedable trusted
// restaurant-display store (frozen UI1-A-R2/R4).
type ResolvableTableRepo = {
  _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  _seedRestaurant(d: { id: string; name: string; is_active: boolean }): void;
  resolveByToken(...a: unknown[]): unknown;
};

function resolvableTableRepo(): ResolvableTableRepo {
  return sharedRepos().restaurantTables as unknown as ResolvableTableRepo;
}

function seedResolvable() {
  resolvableTableRepo()._seed(makeTable());
  resolvableTableRepo()._seedRestaurant({
    id: RESTAURANT_ID,
    name: "Test Restaurant",
    is_active: true,
  });
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use("/api/v1/dine-in", dineInRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("Dine-In session routes (H2.2)", () => {
  let app: Express;

  beforeEach(() => {
    resetDineInState();
    app = buildApp();
  });

  it("A. POST /sessions with a valid body returns 200 { session }", async () => {
    seedTableAndEligibility();
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({ table_token: "token-abc" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.error).toBeNull();
    expect(res.body.data.session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(res.body.data.session.status).toBe("OPEN");
    expect(res.body.data.session.owner_user_id).toBe(TEST_USER_ID);
    expect(res.body.data.session.restaurant_id).toBe(RESTAURANT_ID);
  });

  it("B. POST /sessions with a missing token returns VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.data).toBeNull();
  });

  it("C. caller_user_id comes from auth locals, never the body", async () => {
    seedTableAndEligibility();
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders(TEST_USER_ID))
      .send({
        table_token: "token-abc",
        caller_user_id: "attacker-id",
      })
      .expect(200);

    expect(res.body.data.session.owner_user_id).toBe(TEST_USER_ID);
    expect(res.body.data.session.owner_user_id).not.toBe("attacker-id");
  });

  it("D. correlation comes from locals (inbound header), not the body", async () => {
    seedTableAndEligibility();
    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .set("x-correlation-id", "inbound-corr-123")
      .send({ table_token: "token-abc", correlation_id: "evil-corr" })
      .expect(200);

    expect(res.headers["x-correlation-id"]).toBe("inbound-corr-123");
    expect(res.headers["x-correlation-id"]).not.toBe("evil-corr");
  });

  it("E. table token is taken from the body only, not query", async () => {
    seedTableAndEligibility();

    // Query-only token: body has no token -> VALIDATION_ERROR (query ignored).
    const noBodyToken = await request(app)
      .post("/api/v1/dine-in/sessions?table_token=query-token")
      .set(authHeaders())
      .send({})
      .expect(400);
    expect(noBodyToken.body.error.code).toBe("VALIDATION_ERROR");

    // Body token wins even when a conflicting query token is present.
    const bodyWins = await request(app)
      .post("/api/v1/dine-in/sessions?table_token=query-token")
      .set(authHeaders())
      .send({ table_token: "token-abc" })
      .expect(200);
    expect(bodyWins.body.data.session.table_id).toBe("table-1");
  });

  it("F. POST /sessions/:sessionId/bill returns the exact artifact shape", async () => {
    seedTableAndEligibility();

    const opened = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({ table_token: "token-abc" })
      .expect(200);
    const sessionId = opened.body.data.session.id;

    const orderService = new DineInOrderService(
      getDineInTransactionPort(),
      makeCatalog({ "item-1": makeMenuItem({ price: 100 }) }).catalog,
    );
    const placed = await orderService.placeOrder({
      session_id: sessionId,
      caller_user_id: TEST_USER_ID,
      correlation_id: "seed-corr",
      items: [{ menu_item_id: "item-1", quantity: 2 }],
    });
    if (placed.kind !== "NEW_MUTATION") {
      throw new Error(`expected NEW_MUTATION, got ${placed.kind}`);
    }

    const res = await request(app)
      .post(`/api/v1/dine-in/sessions/${sessionId}/bill`)
      .set(authHeaders())
      .send()
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body.data).sort()).toEqual([
      "bill",
      "bringBillRequest",
      "session",
    ]);
    expect(res.body.data.session.status).toBe("BILL_REQUESTED");
    expect(res.body.data.bill.total_amount).toBe(210);
    expect(res.body.data.bill.food_subtotal).toBe(200);
    expect(res.body.data.bringBillRequest.request_type).toBe("BRING_BILL");
    expect(res.body.data.bringBillRequest.status).toBe("PENDING");
  });

  it("G. PAYMENT_PENDING repeat permits bringBillRequest: null", async () => {
    const repos = sharedRepos();
    (repos.diningSessions as unknown as {
      _seed(s: DiningSessionDTO): DiningSessionDTO;
    })._seed(
      makeSession({
        id: SESSION_ID_2,
        status: "PAYMENT_PENDING",
        bill_requested_at: "2026-08-24T00:00:00.000Z",
        payment_pending_at: "2026-08-24T00:00:00.000Z",
      }),
    );
    (repos.sessionBills as unknown as {
      _seed(b: SessionBillDTO): SessionBillDTO;
    })._seed(makeBill({ session_id: SESSION_ID_2 }));

    const res = await request(app)
      .post(`/api/v1/dine-in/sessions/${SESSION_ID_2}/bill`)
      .set(authHeaders())
      .send()
      .expect(200);

    expect(res.body.data.session.status).toBe("PAYMENT_PENDING");
    expect(res.body.data.bill.total_amount).toBe(210);
    expect(res.body.data.bringBillRequest).toBeNull();
  });

  it("H. invalid session UUID returns VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/sessions/not-a-uuid/bill")
      .set(authHeaders())
      .send()
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("I. requestBill ignores monetary junk in the body (server-authoritative)", async () => {
    seedTableAndEligibility();

    const opened = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({ table_token: "token-abc" })
      .expect(200);
    const sessionId = opened.body.data.session.id;

    const orderService = new DineInOrderService(
      getDineInTransactionPort(),
      makeCatalog({ "item-1": makeMenuItem({ price: 100 }) }).catalog,
    );
    const placed = await orderService.placeOrder({
      session_id: sessionId,
      caller_user_id: TEST_USER_ID,
      correlation_id: "seed-corr",
      items: [{ menu_item_id: "item-1", quantity: 2 }],
    });
    if (placed.kind !== "NEW_MUTATION") {
      throw new Error(`expected NEW_MUTATION, got ${placed.kind}`);
    }

    const res = await request(app)
      .post(`/api/v1/dine-in/sessions/${sessionId}/bill`)
      .set(authHeaders())
      .send({
        subtotal: 1,
        food_subtotal: 1,
        packaging_fee: 99,
        gst: 1,
        total_amount: 1,
        commission: 0,
        payment: { amount: 1, method: "card" },
        bring_bill: false,
      })
      .expect(200);

    expect(res.body.data.bill.total_amount).toBe(210);
    expect(res.body.data.bill.food_subtotal).toBe(200);
  });

  it("J. service AppError status/code passes through unchanged", async () => {
    // Unknown table token -> TABLE_NOT_FOUND 404.
    const unknownTable = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({ table_token: "no-such-token" })
      .expect(404);
    expect(unknownTable.body.error.code).toBe("TABLE_NOT_FOUND");

    // OPEN session (owned by caller) -> SESSION_NOT_BILLABLE 400.
    const repos = sharedRepos();
    (repos.diningSessions as unknown as {
      _seed(s: DiningSessionDTO): DiningSessionDTO;
    })._seed(makeSession());
    const notBillable = await request(app)
      .post(`/api/v1/dine-in/sessions/${SESSION_ID}/bill`)
      .set(authHeaders())
      .send()
      .expect(400);
    expect(notBillable.body.error.code).toBe("SESSION_NOT_BILLABLE");

    // Session owned by another user -> SESSION_NOT_FOUND 404 (no identity
    // leakage; ownership failure collapses to absence).
    const repos2 = sharedRepos();
    (repos2.diningSessions as unknown as {
      _seed(s: DiningSessionDTO): DiningSessionDTO;
    })._seed(makeSession({ owner_user_id: OTHER_USER_ID }));
    const notOwned = await request(app)
      .post(`/api/v1/dine-in/sessions/${SESSION_ID}/bill`)
      .set(authHeaders(TEST_USER_ID))
      .send()
      .expect(404);
    expect(notOwned.body.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("K. unauthenticated requests return the existing 401 behavior", async () => {
    const open = await request(app)
      .post("/api/v1/dine-in/sessions")
      .send({ table_token: "token-abc" })
      .expect(401);
    expect(open.body.error.code).toBe("UNAUTHORIZED");

    const bill = await request(app)
      .post(`/api/v1/dine-in/sessions/${SESSION_ID}/bill`)
      .send()
      .expect(401);
    expect(bill.body.error.code).toBe("UNAUTHORIZED");
  });

  it("L. router and test-constructed services share the same composition", async () => {
    seedTableAndEligibility();

    const opened = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({ table_token: "token-abc" })
      .expect(200);
    const sessionId = opened.body.data.session.id;

    // A separately-constructed service over the SAME singleton port sees the
    // session created through the HTTP router: same token resumes it.
    const testService = new DiningSessionService(
      getDineInTransactionPort(),
      noopEmitter,
    );
    const resumed = await testService.openSession({
      caller_user_id: TEST_USER_ID,
      table_token: "token-abc",
      correlation_id: "corr-resume",
    });
    if (resumed.kind !== "IDEMPOTENT_NO_MUTATION") {
      throw new Error(`expected IDEMPOTENT_NO_MUTATION, got ${resumed.kind}`);
    }
    expect(resumed.value.kind).toBe("RESUMED");
    expect(resumed.value.session.id).toBe(sessionId);
  });

  it("M. no order/service-request endpoints are exposed", async () => {
    const nonRoutes: Array<[string, string]> = [
      ["post", `/api/v1/dine-in/sessions/${SESSION_ID}/orders`],
      ["post", `/api/v1/dine-in/sessions/${SESSION_ID}/requests`],
      ["post", `/api/v1/dine-in/sessions/${SESSION_ID}/cancel`],
      ["get", "/api/v1/dine-in/sessions"],
    ];

    for (const [method, url] of nonRoutes) {
      const req =
        method === "get"
          ? request(app).get(url)
          : request(app).post(url);
      const res = await req.set(authHeaders()).send();
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
  });
});

// ------------------------------------------------------------
// H3 Dine-In order HTTP routes.
// The router's order service runs on the SAME H2.1 singleton port and the
// SAME authoritative catalog repository as the session routes.
// ------------------------------------------------------------

function seedOpenSession(overrides: Partial<DiningSessionDTO> = {}) {
  (sharedRepos().diningSessions as unknown as {
    _seed(s: DiningSessionDTO): DiningSessionDTO;
  })._seed(makeSession(overrides));
}

async function placeOrderOk(
  app: Express,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await request(app)
    .post("/api/v1/dine-in/orders")
    .set(authHeaders())
    .send(body)
    .expect(201);
  return res.body.data.order.id as string;
}

async function advanceToServed(app: Express, orderId: string) {
  for (const target of ["PREPARING", "READY_TO_SERVE", "SERVED"]) {
    await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/advance`)
      .set(authHeaders())
      .send({ target_status: target })
      .expect(200);
  }
}

describe("Dine-In order routes (H3)", () => {
  let app: Express;

  beforeEach(() => {
    resetDineInState();
    resetCatalogRepository();
    app = buildApp();
  });

  it("A. valid placeOrder returns 201 { order }", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({
        session_id: SESSION_ID,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 2 }],
      })
      .expect(201);

    expect(res.body.success).toBe(true);
    const order = res.body.data.order;
    expect(order.status).toBe("PLACED");
    expect(order.session_id).toBe(SESSION_ID);
    expect(order.placed_by).toBe(TEST_USER_ID);
    expect(order.items[0].item_subtotal).toBe(440);
    expect(order.total_amount).toBe(462);
  });

  it("B. caller comes from auth locals, body caller is ignored", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders(TEST_USER_ID))
      .send({
        session_id: SESSION_ID,
        caller_user_id: "attacker-id",
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
      })
      .expect(201);

    expect(res.body.data.order.placed_by).toBe(TEST_USER_ID);
    expect(res.body.data.order.placed_by).not.toBe("attacker-id");
  });

  it("C. correlation comes from locals (inbound header), not the body", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .set("x-correlation-id", "inbound-corr-h3")
      .send({
        session_id: SESSION_ID,
        correlation_id: "evil-corr",
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
      })
      .expect(201);

    expect(res.headers["x-correlation-id"]).toBe("inbound-corr-h3");
    expect(res.headers["x-correlation-id"]).not.toBe("evil-corr");
  });

  it("D. session_id UUID validation -> VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({
        session_id: "not-a-uuid",
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
      })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("E. menu_item_id UUID validation -> VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({
        session_id: SESSION_ID,
        items: [{ menu_item_id: "not-a-uuid", quantity: 1 }],
      })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("F. quantity transport bounds -> VALIDATION_ERROR 400", async () => {
    for (const quantity of [0, 51, 1.5, -1]) {
      const res = await request(app)
        .post("/api/v1/dine-in/orders")
        .set(authHeaders())
        .send({
          session_id: SESSION_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity }],
        })
        .expect(400);

      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("G. empty items preserves the service-owned EMPTY_ORDER error", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({ session_id: SESSION_ID, items: [] })
      .expect(400);

    expect(res.body.error.code).toBe("EMPTY_ORDER");
  });

  it("H. monetary junk never influences the returned price", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({
        session_id: SESSION_ID,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 2 }],
        base_price: 1,
        unit_price: 5,
        item_subtotal: 7,
        subtotal: 1,
        gst: 99,
        total_amount: 1,
        packaging: 0,
        commission: 0,
        payment: { amount: 1, method: "card" },
      })
      .expect(201);

    expect(res.body.data.order.items[0].item_subtotal).toBe(440);
    expect(res.body.data.order.total_amount).toBe(462);
  });

  it("I. customizations are NOT silently stripped (service rejects)", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({
        session_id: SESSION_ID,
        items: [
          { menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [{ name: "Extra Cheese" }] },
        ],
      })
      .expect(400);

    expect(res.body.error.code).toBe("CUSTOMIZATIONS_NOT_SUPPORTED");
  });

  it("J. valid PLACED -> PREPARING advance returns 200 { order }", async () => {
    seedOpenSession();
    const orderId = await placeOrderOk(app, {
      session_id: SESSION_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
    });

    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/advance`)
      .set(authHeaders())
      .send({ target_status: "PREPARING" })
      .expect(200);

    expect(res.body.data.order.status).toBe("PREPARING");
  });

  it("K. invalid advance target -> VALIDATION_ERROR 400", async () => {
    seedOpenSession();
    const orderId = await placeOrderOk(app, {
      session_id: SESSION_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
    });

    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/advance`)
      .set(authHeaders())
      .send({ target_status: "SHIPPED" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("L. advance orderId UUID validation -> VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/orders/not-a-uuid/advance")
      .set(authHeaders())
      .send({ target_status: "PREPARING" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("M. valid cancel returns 200 { order }", async () => {
    seedOpenSession();
    const orderId = await placeOrderOk(app, {
      session_id: SESSION_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
    });

    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/cancel`)
      .set(authHeaders())
      .send()
      .expect(200);

    expect(res.body.data.order.status).toBe("CANCELLED");
    expect(res.body.data.order.cancelled_by).toBe(TEST_USER_ID);
  });

  it("N. cancel orderId UUID validation -> VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/orders/not-a-uuid/cancel")
      .set(authHeaders())
      .send()
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("O. cancellation audit metadata cannot be client supplied", async () => {
    seedOpenSession();
    const orderId = await placeOrderOk(app, {
      session_id: SESSION_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
    });

    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/cancel`)
      .set(authHeaders())
      .send({
        cancelled_by: "attacker-id",
        cancelled_at: "2099-01-01T00:00:00.000Z",
        reason: "client reason",
      })
      .expect(200);

    expect(res.body.data.order.cancelled_by).toBe(TEST_USER_ID);
    expect(res.body.data.order.cancelled_at).not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("P1. closed session placeOrder -> SESSION_CLOSED_FOR_ORDERING 409", async () => {
    seedOpenSession({ status: "CLOSED" });
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({
        session_id: SESSION_ID,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
      })
      .expect(409);

    expect(res.body.error.code).toBe("SESSION_CLOSED_FOR_ORDERING");
  });

  it("P2. advance unknown order -> ORDER_NOT_FOUND 404", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/advance")
      .set(authHeaders())
      .send({ target_status: "PREPARING" })
      .expect(404);

    expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
  });

  it("P3. unknown menu item -> ITEM_NOT_FOUND 404", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({
        session_id: SESSION_ID,
        items: [{ menu_item_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", quantity: 1 }],
      })
      .expect(404);

    expect(res.body.error.code).toBe("ITEM_NOT_FOUND");
  });

  it("P4. cancel SERVED order -> ORDER_NOT_CANCELLABLE 409", async () => {
    seedOpenSession();
    const orderId = await placeOrderOk(app, {
      session_id: SESSION_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
    });
    await advanceToServed(app, orderId);

    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/cancel`)
      .set(authHeaders())
      .send()
      .expect(409);

    expect(res.body.error.code).toBe("ORDER_NOT_CANCELLABLE");
  });

  it("P5. skip advance -> INVALID_DINE_IN_TRANSITION 409", async () => {
    seedOpenSession();
    const orderId = await placeOrderOk(app, {
      session_id: SESSION_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
    });

    const res = await request(app)
      .post(`/api/v1/dine-in/orders/${orderId}/advance`)
      .set(authHeaders())
      .send({ target_status: "SERVED" })
      .expect(409);

    expect(res.body.error.code).toBe("INVALID_DINE_IN_TRANSITION");
  });

  it("Q. order route shares the same transaction-port universe as the session route", async () => {
    seedTableAndEligibility();

    const opened = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({ table_token: "token-abc" })
      .expect(200);
    const sessionId = opened.body.data.session.id;

    const res = await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({
        session_id: sessionId,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
      })
      .expect(201);

    expect(res.body.data.order.session_id).toBe(sessionId);
  });

  it("R. no service-request endpoints are exposed by H3", async () => {
    const nonRoutes: Array<[string, string]> = [
      ["post", "/api/v1/dine-in/orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/requests"],
      ["post", "/api/v1/dine-in/orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/ack"],
      ["post", "/api/v1/dine-in/orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/complete"],
      ["post", "/api/v1/dine-in/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/requests"],
      ["get", "/api/v1/dine-in/orders"],
    ];

    for (const [method, url] of nonRoutes) {
      const req =
        method === "get"
          ? request(app).get(url)
          : request(app).post(url);
      const res = await req.set(authHeaders()).send();
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
  });
});

// ------------------------------------------------------------
// H4 Dine-In service-request HTTP routes.
//
// create (201 { request }), acknowledge / complete / cancel (200 { request }).
// BRING_BILL is unreachable through the generic create transport (enum).
// Acknowledge / complete / cancel never read req.body — audit fields and
// server timestamps are server-authoritative from locals only.
// ------------------------------------------------------------

function makeServiceRequest(
  overrides: Partial<ServiceRequestDTO> = {},
): ServiceRequestDTO {
  return {
    id: REQUEST_ID,
    session_id: SESSION_ID,
    restaurant_id: RESTAURANT_ID,
    requested_by: TEST_USER_ID,
    request_type: "WATER",
    status: "PENDING",
    note: null,
    acknowledged_by: null,
    acknowledged_at: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function seedServiceRequest(overrides: Partial<ServiceRequestDTO> = {}) {
  return (sharedRepos().serviceRequests as unknown as {
    _seed(r: ServiceRequestDTO): ServiceRequestDTO;
  })._seed(makeServiceRequest(overrides));
}

describe("Dine-In service-request routes (H4)", () => {
  let app: Express;

  beforeEach(() => {
    resetDineInState();
    app = buildApp();
  });

  it("A. POST /service-requests with a valid body returns 201 { request }", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({ session_id: SESSION_ID, request_type: "WATER" })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.error).toBeNull();
    expect(res.body.data.request.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(res.body.data.request.session_id).toBe(SESSION_ID);
    expect(res.body.data.request.request_type).toBe("WATER");
    expect(res.body.data.request.status).toBe("PENDING");
    expect(res.body.data.request.requested_by).toBe(TEST_USER_ID);
  });

  it("B. OTHER request accepts and trims the note", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({
        session_id: SESSION_ID,
        request_type: "OTHER",
        note: "  Please clean table 4  ",
      })
      .expect(201);

    expect(res.body.data.request.note).toBe("Please clean table 4");
  });

  it("C. OTHER request without a note fails with the service-owned error", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({ session_id: SESSION_ID, request_type: "OTHER" })
      .expect(400);

    expect(res.body.error.code).toBe("OTHER_NOTE_REQUIRED");
  });

  it("D. BRING_BILL is unreachable through the generic create transport", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({ session_id: SESSION_ID, request_type: "BRING_BILL" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("E. session_id must be a UUID", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({ session_id: "not-a-uuid", request_type: "WATER" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("F. caller_user_id comes from auth locals, never the body", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders(TEST_USER_ID))
      .send({
        session_id: SESSION_ID,
        request_type: "WATER",
        caller_user_id: "attacker-id",
      })
      .expect(201);

    expect(res.body.data.request.requested_by).toBe(TEST_USER_ID);
    expect(res.body.data.request.requested_by).not.toBe("attacker-id");
  });

  it("G. correlation comes from locals (inbound header), not the body", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .set("x-correlation-id", "inbound-corr-sr")
      .send({
        session_id: SESSION_ID,
        request_type: "WATER",
        correlation_id: "evil-corr",
      })
      .expect(201);

    expect(res.headers["x-correlation-id"]).toBe("inbound-corr-sr");
    expect(res.headers["x-correlation-id"]).not.toBe("evil-corr");
  });

  it("H. unknown request_type is rejected at the transport boundary", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({ session_id: SESSION_ID, request_type: "LAUNDRY" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("I. acknowledge returns 200 { request } with server-authoritative audit", async () => {
    seedOpenSession();
    seedServiceRequest();
    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${REQUEST_ID}/acknowledge`)
      .set(authHeaders())
      .send({ acknowledged_by: "attacker", acknowledged_at: "2099-01-01T00:00:00.000Z" })
      .expect(200);

    expect(res.body.data.request.status).toBe("ACKNOWLEDGED");
    expect(res.body.data.request.acknowledged_by).toBe(TEST_USER_ID);
    expect(res.body.data.request.acknowledged_by).not.toBe("attacker");
    expect(res.body.data.request.acknowledged_at).not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("J. acknowledge with a non-UUID request id is a transport 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests/not-a-uuid/acknowledge")
      .set(authHeaders())
      .send()
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("K. complete returns 200 { request } after an acknowledged request", async () => {
    seedOpenSession();
    seedServiceRequest();
    await request(app)
      .post(`/api/v1/dine-in/service-requests/${REQUEST_ID}/acknowledge`)
      .set(authHeaders())
      .send()
      .expect(200);

    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${REQUEST_ID}/complete`)
      .set(authHeaders())
      .send({ completed_by: "attacker", completed_at: "2099-01-01T00:00:00.000Z" })
      .expect(200);

    expect(res.body.data.request.status).toBe("COMPLETED");
    expect(res.body.data.request.completed_by).toBe(TEST_USER_ID);
    expect(res.body.data.request.completed_by).not.toBe("attacker");
    expect(res.body.data.request.completed_at).not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("L. complete with a non-UUID request id is a transport 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests/not-a-uuid/complete")
      .set(authHeaders())
      .send()
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("M. cancel returns 200 { request } with server-authoritative audit", async () => {
    seedOpenSession();
    seedServiceRequest();
    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${REQUEST_ID}/cancel`)
      .set(authHeaders())
      .send({ cancelled_by: "attacker", cancelled_at: "2099-01-01T00:00:00.000Z" })
      .expect(200);

    expect(res.body.data.request.status).toBe("CANCELLED");
    expect(res.body.data.request.cancelled_by).toBe(TEST_USER_ID);
    expect(res.body.data.request.cancelled_by).not.toBe("attacker");
    expect(res.body.data.request.cancelled_at).not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("N. cancel with a non-UUID request id is a transport 400", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests/not-a-uuid/cancel")
      .set(authHeaders())
      .send()
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("O. cancelling a BRING_BILL request hits the service-owned 409 boundary", async () => {
    seedOpenSession();
    seedServiceRequest({ request_type: "BRING_BILL" });
    const res = await request(app)
      .post(`/api/v1/dine-in/service-requests/${REQUEST_ID}/cancel`)
      .set(authHeaders())
      .send()
      .expect(409);

    expect(res.body.error.code).toBe("BRING_BILL_MANAGED_BY_BILL_FLOW");
  });

  it("P. service AppErrors pass through unchanged (404/409)", async () => {
    // Unknown request -> SERVICE_REQUEST_NOT_FOUND 404.
    const notFound = await request(app)
      .post(
        "/api/v1/dine-in/service-requests/99999999-9999-4999-8999-999999999999/acknowledge",
      )
      .set(authHeaders())
      .send()
      .expect(404);
    expect(notFound.body.error.code).toBe("SERVICE_REQUEST_NOT_FOUND");

    // Complete on a PENDING request is an invalid transition 409.
    seedOpenSession();
    seedServiceRequest();
    const badComplete = await request(app)
      .post(`/api/v1/dine-in/service-requests/${REQUEST_ID}/complete`)
      .set(authHeaders())
      .send()
      .expect(409);
    expect(badComplete.body.error.code).toBe("INVALID_SERVICE_REQUEST_TRANSITION");

    // Acknowledge on an already-cancelled request is an invalid transition 409.
    seedServiceRequest({ status: "CANCELLED", cancelled_by: TEST_USER_ID });
    const badAck = await request(app)
      .post(`/api/v1/dine-in/service-requests/${REQUEST_ID}/acknowledge`)
      .set(authHeaders())
      .send()
      .expect(409);
    expect(badAck.body.error.code).toBe("INVALID_SERVICE_REQUEST_TRANSITION");
  });

  it("Q. create on a missing session returns SERVICE_NOT_FOUND 404", async () => {
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({ session_id: SESSION_ID, request_type: "WATER" })
      .expect(404);

    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("R. staff/zone/role/assignee body fields are never forwarded", async () => {
    seedOpenSession();
    const res = await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({
        session_id: SESSION_ID,
        request_type: "WATER",
        staff_assignment_id: "attacker-assignment",
        staff_user_id: "attacker-staff",
        zone_id: "attacker-zone",
        role: "MANAGER",
        assignee: "attacker",
      })
      .expect(201);

    expect(res.body.data.request.requested_by).toBe(TEST_USER_ID);
    expect(res.body.data.request).not.toHaveProperty("staff_assignment_id");
    expect(res.body.data.request).not.toHaveProperty("staff_user_id");
    expect(res.body.data.request).not.toHaveProperty("zone_id");
    expect(res.body.data.request).not.toHaveProperty("role");
    expect(res.body.data.request).not.toHaveProperty("assignee");
  });

  it("S. existing session and order routes remain green after H4", async () => {
    seedTableAndEligibility();

    const opened = await request(app)
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({ table_token: "token-abc" })
      .expect(200);
    const sessionId = opened.body.data.session.id;

    await request(app)
      .post("/api/v1/dine-in/orders")
      .set(authHeaders())
      .send({
        session_id: sessionId,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1 }],
      })
      .expect(201);

    await request(app)
      .post("/api/v1/dine-in/service-requests")
      .set(authHeaders())
      .send({ session_id: sessionId, request_type: "WATER" })
      .expect(201);
  });

  it("T. router exposes exactly 10 dine-in routes after R4", () => {
    expect(dineInRouter.stack).toHaveLength(10);
  });
});

// ------------------------------------------------------------
// UI1-A-R4: public table resolve route.
//
// Public GET /tables/resolve (NO authenticate) while every session/order/
// request mutation route stays behind authenticate. Envelope + error codes are
// the existing ones (VALIDATION_ERROR 400 / TABLE_NOT_FOUND 404 / INTERNAL
// ERROR 500) — no new taxonomy. The router-level harness mounts the same stack
// as app.ts, so the public-vs-auth boundary is exercised exactly as shipped.
// ------------------------------------------------------------
describe("UI1-A-R4 public table resolve route", () => {
  let app: Express;

  beforeEach(() => {
    resetDineInState();
    app = buildApp();
  });

  it("A. known token returns 200 with the exact DTO and no token echo", async () => {
    seedResolvable();
    const res = await request(app)
      .get("/api/v1/dine-in/tables/resolve?token=token-abc")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toEqual({
      restaurant: { id: RESTAURANT_ID, name: "Test Restaurant" },
      table: { id: "table-1", label: "T1" },
      can_start_session: true,
    });
    expect(JSON.stringify(res.body)).not.toContain("token-abc");
  });

  it("B. missing token returns VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .get("/api/v1/dine-in/tables/resolve")
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.data).toBeNull();
  });

  it("C. empty token returns VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .get("/api/v1/dine-in/tables/resolve?token=")
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("D. unknown token returns TABLE_NOT_FOUND 404 with no token echo", async () => {
    seedResolvable();
    const res = await request(app)
      .get("/api/v1/dine-in/tables/resolve?token=unknown-token")
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("TABLE_NOT_FOUND");
    expect(res.body.data).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("unknown-token");
  });

  it("E. disabled table collapses to TABLE_NOT_FOUND 404", async () => {
    resolvableTableRepo()._seed(makeTable({ is_active: false }));
    resolvableTableRepo()._seedRestaurant({
      id: RESTAURANT_ID,
      name: "Test Restaurant",
      is_active: true,
    });
    const res = await request(app)
      .get("/api/v1/dine-in/tables/resolve?token=token-abc")
      .expect(404);

    expect(res.body.error.code).toBe("TABLE_NOT_FOUND");
  });

  it("F. inactive restaurant collapses to TABLE_NOT_FOUND 404", async () => {
    resolvableTableRepo()._seed(makeTable());
    resolvableTableRepo()._seedRestaurant({
      id: RESTAURANT_ID,
      name: "Test Restaurant",
      is_active: false,
    });
    const res = await request(app)
      .get("/api/v1/dine-in/tables/resolve?token=token-abc")
      .expect(404);

    expect(res.body.error.code).toBe("TABLE_NOT_FOUND");
  });

  it("G. resolver called once per request; no session-create mutation path", async () => {
    seedResolvable();
    const tableRepo = resolvableTableRepo();
    const resolveSpy = vi.spyOn(tableRepo, "resolveByToken");
    const createSpy = vi.spyOn(
      sharedRepos().diningSessions as unknown as {
        create(...a: unknown[]): unknown;
      },
      "create",
    );
    try {
      const res = await request(app)
        .get("/api/v1/dine-in/tables/resolve?token=token-abc")
        .expect(200);
      expect(res.body.data.table.id).toBe("table-1");
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith("token-abc");
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      resolveSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it("H. resolve stays public while POST /sessions stays authenticated", async () => {
    seedResolvable();
    await request(app)
      .get("/api/v1/dine-in/tables/resolve?token=token-abc")
      .expect(200);

    const res = await request(app)
      .post("/api/v1/dine-in/sessions")
      .send({ table_token: "token-abc" })
      .expect(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });
});
