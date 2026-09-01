import { describe, expect, it, vi, afterEach } from "vitest";
import {
  openDineInSession,
  placeDineInOrder,
  createDineInServiceRequest,
  requestDineInBill,
  resolveDineInTable,
} from "./api";

describe("dine-in API helpers (UI1-B2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolveDineInTable issues a public GET with the encoded token and no auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        data: {
          restaurant: { id: "r", name: "R" },
          table: { id: "t", label: "T1" },
          can_start_session: true,
        },
        error: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await resolveDineInTable("a b/c?");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/tables/resolve?token=a%20b%2Fc%3F");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.headers).toBeUndefined();
  });

  it("openDineInSession POSTs table_token with Bearer auth and returns the session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        data: {
          session: {
            id: "s1",
            restaurant_id: "r1",
            table_id: "t1",
            owner_user_id: "u1",
            status: "OPEN",
            bill_requested_at: null,
            payment_pending_at: null,
            closed_at: null,
            created_at: "2026-08-30T00:00:00.000Z",
            updated_at: "2026-08-30T00:00:00.000Z",
          },
        },
        error: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await openDineInSession("tok-123", "access-tok");

    expect(result.session.id).toBe("s1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/sessions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ table_token: "tok-123" });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer access-tok",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("openDineInSession surfaces HTTP status + envelope code on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({
        success: false,
        data: null,
        error: { code: "TABLE_OCCUPIED", message: "Table occupied" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const err = (await openDineInSession("tok", "at").catch(
      (e: Error & { status?: number; code?: string }) => e,
    )) as Error & { status?: number; code?: string };

    expect(err.status).toBe(409);
    expect(err.code).toBe("TABLE_OCCUPIED");
  });
});

describe("placeDineInOrder (UI4-A)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs exactly session_id + {menu_item_id, quantity} lines with Bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 201,
      json: async () => ({
        success: true,
        data: {
          order: {
            id: "o1",
            session_id: "s1",
            restaurant_id: "r1",
            placed_by: "u1",
            status: "PLACED",
            total_amount: 236,
            notes: null,
            served_at: null,
            cancelled_at: null,
            created_at: "2026-08-30T00:00:00.000Z",
            updated_at: "2026-08-30T00:00:00.000Z",
          },
        },
        error: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await placeDineInOrder("s1", [
      { menu_item_id: "m1", quantity: 2 },
      { menu_item_id: "m2", quantity: 1 },
    ], "access-tok");

    expect(result.order.id).toBe("o1");
    expect(result.order.total_amount).toBe(236);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/orders");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      session_id: "s1",
      items: [
        { menu_item_id: "m1", quantity: 2 },
        { menu_item_id: "m2", quantity: 1 },
      ],
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-tok");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("surfaces HTTP status + envelope code on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 404,
      json: async () => ({
        success: false,
        data: null,
        error: { code: "ITEM_NOT_FOUND", message: "Item gone" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const err = (await placeDineInOrder("s1", [
      { menu_item_id: "m1", quantity: 1 },
    ], "at").catch((e: Error & { status?: number; code?: string }) => e)) as Error & {
      status?: number;
      code?: string;
    };

    expect(err.status).toBe(404);
    expect(err.code).toBe("ITEM_NOT_FOUND");
  });
});

describe("createDineInServiceRequest (UI5-B)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const REQUEST = {
    id: "sr-1",
    session_id: "s1",
    restaurant_id: "r1",
    requested_by: "u1",
    request_type: "WATER",
    status: "PENDING",
    note: null,
    acknowledged_by: null,
    acknowledged_at: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:00:00.000Z",
  };

  function stubSuccess(overrides: Record<string, unknown> = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 201,
      json: async () => ({
        success: true,
        data: { request: { ...REQUEST, ...overrides } },
        error: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("POSTs exactly session_id + request_type to /api/v1/dine-in/service-requests with Bearer auth", async () => {
    const fetchMock = stubSuccess();

    const result = await createDineInServiceRequest(
      "s1",
      "WATER",
      undefined,
      "access-tok",
    );

    expect(result.request.id).toBe("sr-1");
    expect(result.request.status).toBe("PENDING");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/service-requests");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      session_id: "s1",
      request_type: "WATER",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-tok");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("OTHER sends the trimmed note", async () => {
    const fetchMock = stubSuccess({ request_type: "OTHER", note: "Need waiter" });

    await createDineInServiceRequest("s1", "OTHER", "Need waiter", "access-tok");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/service-requests");
    expect(JSON.parse(String(init.body))).toEqual({
      session_id: "s1",
      request_type: "OTHER",
      note: "Need waiter",
    });
  });

  it("non-OTHER omits note entirely even if one is supplied", async () => {
    const fetchMock = stubSuccess();

    await createDineInServiceRequest("s1", "CALL_STAFF", "extra note", "access-tok");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/service-requests");
    expect(JSON.parse(String(init.body))).toEqual({
      session_id: "s1",
      request_type: "CALL_STAFF",
    });
  });

  it("body never contains token, table/restaurant ids, status, caller id or timestamps", async () => {
    const fetchMock = stubSuccess();

    await createDineInServiceRequest("s1", "TISSUE", undefined, "access-tok");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/service-requests");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["request_type", "session_id"]);
    const raw = String(init.body);
    expect(raw).not.toContain("access-tok");
    expect(raw).not.toContain("table_id");
    expect(raw).not.toContain("restaurant_id");
    expect(raw).not.toContain("status");
    expect(raw).not.toContain("requested_by");
    expect(raw).not.toContain("created_at");
  });

  it("surfaces HTTP status + envelope code on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({
        success: false,
        data: null,
        error: { code: "SESSION_CLOSED_FOR_REQUEST", message: "Session closed" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const err = (await createDineInServiceRequest("s1", "WATER", undefined, "at").catch(
      (e: Error & { status?: number; code?: string }) => e,
    )) as Error & { status?: number; code?: string };

    expect(err.status).toBe(409);
    expect(err.code).toBe("SESSION_CLOSED_FOR_REQUEST");
  });
});

describe("requestDineInBill (UI6-B)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SESSION = {
    id: "s1",
    restaurant_id: "r1",
    table_id: "t1",
    owner_user_id: "u1",
    status: "BILL_REQUESTED",
    bill_requested_at: "2026-08-30T00:00:00.000Z",
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:00:00.000Z",
  };

  const BILL = {
    id: "bill-1",
    session_id: "s1",
    restaurant_id: "r1",
    food_subtotal: 1000,
    packaging_fee: 0,
    gst_food: 50,
    gst_packaging: 0,
    total_amount: 1050,
    frozen_at: "2026-08-30T00:00:00.000Z",
    created_at: "2026-08-30T00:00:00.000Z",
  };

  const BRING_BILL = {
    id: "sr-bill-1",
    session_id: "s1",
    restaurant_id: "r1",
    requested_by: "u1",
    request_type: "BRING_BILL",
    status: "PENDING",
    note: null,
    acknowledged_by: null,
    acknowledged_at: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:00:00.000Z",
  };

  function stubSuccess(overrides: Record<string, unknown> = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        data: {
          session: { ...SESSION },
          bill: { ...BILL },
          bringBillRequest: { ...BRING_BILL },
          ...overrides,
        },
        error: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("POSTs to the exact encoded session bill URL with no body and Bearer auth", async () => {
    const fetchMock = stubSuccess();

    const result = await requestDineInBill("s1", "access-tok");

    expect(result.session.status).toBe("BILL_REQUESTED");
    expect(result.bill.food_subtotal).toBe(1000);
    expect(result.bill.total_amount).toBe(1050);
    expect(result.bringBillRequest?.request_type).toBe("BRING_BILL");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/sessions/s1/bill");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-tok");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("encodes a session id with special characters in the URL path", async () => {
    const fetchMock = stubSuccess();

    await requestDineInBill("s/1?x", "access-tok");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/sessions/s%2F1%3Fx/bill");
  });

  it("never sends session_id, restaurant/table ids, prices, GST, token, request type or payment fields", async () => {
    const fetchMock = stubSuccess();

    await requestDineInBill("s1", "access-tok");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(url).toBe("/api/v1/dine-in/sessions/s1/bill");
    expect(url).not.toContain("restaurant_id");
    expect(url).not.toContain("table_id");
    expect(url).not.toContain("request_type");
    expect(url).not.toContain("price");
    expect(url).not.toContain("gst");
    expect(url).not.toContain("payment");
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers ?? {}).sort()).toEqual(["Authorization"]);
  });

  it("maps the full authoritative response (session + bill + bringBillRequest)", async () => {
    stubSuccess();

    const result = await requestDineInBill("s1", "access-tok");

    expect(result.session.id).toBe("s1");
    expect(result.session.status).toBe("BILL_REQUESTED");
    expect(result.bill).toEqual({ ...BILL });
    expect(result.bringBillRequest).toEqual({ ...BRING_BILL });
  });

  it("surfaces HTTP status + envelope code on failure (SESSION_NOT_BILLABLE 400)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 400,
        json: async () => ({
          success: false,
          data: null,
          error: { code: "SESSION_NOT_BILLABLE", message: "Not billable" },
        }),
      }),
    );

    const err = (await requestDineInBill("s1", "at").catch(
      (e: Error & { status?: number; code?: string }) => e,
    )) as Error & { status?: number; code?: string };

    expect(err.status).toBe(400);
    expect(err.code).toBe("SESSION_NOT_BILLABLE");
  });

  it("surfaces HTTP status + envelope code on failure (SESSION_NOT_FOUND 404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 404,
        json: async () => ({
          success: false,
          data: null,
          error: { code: "SESSION_NOT_FOUND", message: "Gone" },
        }),
      }),
    );

    const err = (await requestDineInBill("s1", "at").catch(
      (e: Error & { status?: number; code?: string }) => e,
    )) as Error & { status?: number; code?: string };

    expect(err.status).toBe(404);
    expect(err.code).toBe("SESSION_NOT_FOUND");
  });

  it("surfaces HTTP status + envelope code on failure (BILL_INVARIANT_VIOLATION 500)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 500,
        json: async () => ({
          success: false,
          data: null,
          error: {
            code: "BILL_INVARIANT_VIOLATION",
            message: "Invariant broken",
          },
        }),
      }),
    );

    const err = (await requestDineInBill("s1", "at").catch(
      (e: Error & { status?: number; code?: string }) => e,
    )) as Error & { status?: number; code?: string };

    expect(err.status).toBe(500);
    expect(err.code).toBe("BILL_INVARIANT_VIOLATION");
  });

  it("surfaces HTTP status + envelope code on failure (UNAUTHORIZED 401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 401,
        json: async () => ({
          success: false,
          data: null,
          error: { code: "UNAUTHORIZED", message: "Bad token" },
        }),
      }),
    );

    const err = (await requestDineInBill("s1", "at").catch(
      (e: Error & { status?: number; code?: string }) => e,
    )) as Error & { status?: number; code?: string };

    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
  });
});
