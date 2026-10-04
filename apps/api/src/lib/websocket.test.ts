import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { config } from "../config";
import { sharedIdentityRepo, sharedOrderRepo, sharedUserRoleRepo } from "../repositories/shared";
import type { IdentityUser } from "../repositories/identityRepository";
import type { OrderDTO } from "../repositories/orderRepository";
import { jwtService } from "../services/jwt";
import { broadcast, initWebSocketServer } from "./websocket";
import type { OrderStatusUpdate } from "./websocket";

const CONSUMER_ID = "u-ws-consumer-000000000001";
const OTHER_CONSUMER_ID = "u-ws-consumer-000000000002";
const VENDOR_OWNER_ID = "e0000000-0000-4000-a000-000000000001";
const VENDOR_STAFF_ID = "u-ws-vendor-staff-00000001";
const ADMIN_ID = "u-ws-admin-00000000000001";
const REST_ID = "a0000000-0000-4000-8000-000000000001";
const OTHER_REST_ID = "a0000000-0000-4000-8000-000000000002";
const ORDER_ID = "o-ws-owned-00000000000001";
const FOREIGN_ORDER_ID = "o-ws-foreign-000000000001";

function seedUser(
  id: string,
  role: string,
  overrides: Partial<IdentityUser> = {},
): void {
  sharedIdentityRepo._seed({
    id,
    phone: overrides.phone ?? `+9110${id.replace(/\D/g, "").slice(-8).padStart(8, "0")}`,
    role,
    is_suspended: overrides.is_suspended ?? false,
    totp_enabled: false,
    created_at: new Date().toISOString(),
    ...overrides,
  });
}

function seedOrder(id: string, userId: string, restaurantId = REST_ID): OrderDTO {
  return sharedOrderRepo._seed({
    id,
    user_id: userId,
    restaurant_id: restaurantId,
    items: [],
    total_amount: 100,
    status: "CONFIRMED",
    commission_rate: 0.08,
    commission_amount: 0,
    pickup_otp: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: "2026-10-04T00:00:00.000Z",
    updated_at: "2026-10-04T00:00:00.000Z",
  });
}

function accessToken(sub: string, role: string, phone = "+919876543210"): string {
  return jwtService.signAccessToken({
    sub,
    phone,
    role,
    device_fingerprint: "ws-g4-fp",
  });
}

function statusUpdate(
  orderId = ORDER_ID,
  restaurantId = REST_ID,
): OrderStatusUpdate {
  return {
    event: "ORDER_STATUS_UPDATE",
    data: {
      order_id: orderId,
      restaurant_id: restaurantId,
      sql_status: "PREPARING",
      ui_status: "Preparing",
      timestamp: "2026-10-04T00:00:00.000Z",
    },
  };
}

interface Harness {
  ws: WebSocket;
  messages: unknown[];
  closeCode: number | null;
  closeReason: string;
  opened: boolean;
}

function openClient(
  url: string,
  headers: Record<string, string> = {},
): Promise<Harness> {
  const harness: Harness = {
    ws: new WebSocket(url, { headers }),
    messages: [],
    closeCode: null,
    closeReason: "",
    opened: false,
  };
  harness.ws.on("message", (raw) => {
    try {
      harness.messages.push(JSON.parse(String(raw)));
    } catch {
      harness.messages.push(String(raw));
    }
  });
  harness.ws.on("open", () => {
    harness.opened = true;
  });
  harness.ws.on("close", (code, reason) => {
    harness.closeCode = code;
    harness.closeReason = String(reason);
    harness.opened = false;
  });
  return new Promise((resolve) => {
    const done = () => resolve(harness);
    harness.ws.once("open", done);
    harness.ws.once("close", done);
  });
}

async function waitForClose(h: Harness, timeoutMs = 1000): Promise<void> {
  if (h.closeCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for ws close")),
      timeoutMs,
    );
    h.ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("AUTH-G4 WebSocket handshake, subscribe, delivery revocation", () => {
  let httpServer: Server;
  let baseUrl: string;
  const live: Harness[] = [];

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    initWebSocketServer(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = httpServer.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${addr.port}/api/v1/ws`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    sharedIdentityRepo._reset();
    sharedOrderRepo._reset();
    sharedUserRoleRepo._reset();
    seedUser(CONSUMER_ID, "CONSUMER");
    seedUser(OTHER_CONSUMER_ID, "CONSUMER");
    seedUser(VENDOR_OWNER_ID, "VENDOR_OWNER", { phone: "+919876000101" });
    seedUser(VENDOR_STAFF_ID, "VENDOR_STAFF");
    seedUser(ADMIN_ID, "ADMIN");
    seedOrder(ORDER_ID, CONSUMER_ID, REST_ID);
    seedOrder(FOREIGN_ORDER_ID, OTHER_CONSUMER_ID, REST_ID);
  });

  afterEach(async () => {
    for (const h of live.splice(0)) {
      if (h.ws.readyState === WebSocket.OPEN || h.ws.readyState === WebSocket.CONNECTING) {
        h.ws.close();
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  });

  async function connect(opts: {
    bearer?: string;
    cookie?: string;
    queryToken?: string;
  }): Promise<Harness> {
    const url = opts.queryToken
      ? `${baseUrl}?token=${encodeURIComponent(opts.queryToken)}`
      : baseUrl;
    const headers: Record<string, string> = {};
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    if (opts.cookie) {
      headers.Cookie = `${config.jwt.accessCookieName}=${opts.cookie}`;
    }
    const h = await openClient(url, headers);
    live.push(h);
    return h;
  }

  it("WS-1 valid access cookie → connection accepted", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ cookie: token });
    expect(h.opened).toBe(true);
    expect(h.closeCode).toBeNull();
  });

  it("WS-2 valid Authorization Bearer access token → connection accepted", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ bearer: token });
    expect(h.opened).toBe(true);
    expect(h.closeCode).toBeNull();
  });

  it("WS-3 valid JWT only in ?token= → rejected 1008", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ queryToken: token });
    if (h.closeCode === null) await waitForClose(h);
    expect(h.opened).toBe(false);
    expect(h.closeCode).toBe(1008);
  });

  it("WS-4 invalid access cookie/token → rejected", async () => {
    const h = await connect({ bearer: "not-a-jwt" });
    if (h.closeCode === null) await waitForClose(h);
    expect(h.closeCode).toBe(1008);
  });

  it("WS-5 deleted identity with otherwise-valid JWT → rejected", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    sharedIdentityRepo._reset();
    seedUser(VENDOR_OWNER_ID, "VENDOR_OWNER", { phone: "+919876000101" });
    const h = await connect({ bearer: token });
    if (h.closeCode === null) await waitForClose(h);
    expect(h.closeCode).toBe(1008);
  });

  it("WS-6 suspended identity with otherwise-valid JWT → rejected", async () => {
    await sharedIdentityRepo.suspend(CONSUMER_ID, "abuse");
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ bearer: token });
    if (h.closeCode === null) await waitForClose(h);
    expect(h.closeCode).toBe(1008);
  });

  it("WS-7 stale JWT role → durable current role governs authorization", async () => {
    const token = accessToken(CONSUMER_ID, "VENDOR_OWNER");
    const h = await connect({ bearer: token });
    expect(h.opened).toBe(true);
    h.ws.send(
      JSON.stringify({ type: "subscribe_restaurant", restaurant_id: REST_ID }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await broadcast(statusUpdate());
    await new Promise((r) => setTimeout(r, 50));
    expect(h.messages).toEqual([]);
  });

  it("WS-SUB-1 consumer own order → allowed", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ bearer: token });
    h.ws.send(JSON.stringify({ type: "subscribe", order_id: ORDER_ID }));
    await new Promise((r) => setTimeout(r, 50));
    await broadcast(statusUpdate());
    await waitUntil(() => h.messages.length > 0);
    expect(h.messages[0]).toMatchObject({
      event: "ORDER_STATUS_UPDATE",
      data: { order_id: ORDER_ID },
    });
  });

  it("WS-SUB-2 consumer foreign order → denied", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ bearer: token });
    h.ws.send(JSON.stringify({ type: "subscribe", order_id: FOREIGN_ORDER_ID }));
    await new Promise((r) => setTimeout(r, 50));
    await broadcast(statusUpdate(FOREIGN_ORDER_ID));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.messages).toEqual([]);
  });

  it("WS-SUB-3 authorized vendor restaurant/order → allowed", async () => {
    const token = accessToken(VENDOR_OWNER_ID, "VENDOR_OWNER");
    const h = await connect({ bearer: token });
    h.ws.send(
      JSON.stringify({ type: "subscribe_restaurant", restaurant_id: REST_ID }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await broadcast(statusUpdate());
    await waitUntil(() => h.messages.length > 0);
    expect(h.messages[0]).toMatchObject({
      event: "ORDER_STATUS_UPDATE",
      data: { restaurant_id: REST_ID },
    });
  });

  it("WS-SUB-4 unauthorized vendor restaurant/order → denied", async () => {
    const token = accessToken(VENDOR_OWNER_ID, "VENDOR_OWNER");
    const h = await connect({ bearer: token });
    h.ws.send(
      JSON.stringify({
        type: "subscribe_restaurant",
        restaurant_id: OTHER_REST_ID,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await broadcast(statusUpdate(ORDER_ID, OTHER_REST_ID));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.messages).toEqual([]);
  });

  it("WS-SUB-5 platform role → existing legal behavior preserved", async () => {
    const token = accessToken(ADMIN_ID, "ADMIN");
    const h = await connect({ bearer: token });
    h.ws.send(JSON.stringify({ type: "subscribe", order_id: ORDER_ID }));
    await new Promise((r) => setTimeout(r, 50));
    await broadcast(statusUpdate());
    await waitUntil(() => h.messages.length > 0);
    expect(h.messages[0]).toMatchObject({
      event: "ORDER_STATUS_UPDATE",
      data: { order_id: ORDER_ID },
    });
  });

  it("WS-SUB-6 identity suspended AFTER socket connection, before subscribe → denied / closed", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ bearer: token });
    expect(h.opened).toBe(true);
    await sharedIdentityRepo.suspend(CONSUMER_ID, "post-connect");
    h.ws.send(JSON.stringify({ type: "subscribe", order_id: ORDER_ID }));
    await new Promise((r) => setTimeout(r, 80));
    await broadcast(statusUpdate());
    await new Promise((r) => setTimeout(r, 80));
    expect(h.messages).toEqual([]);
  });

  it("WS-SUB-7 role/access changed AFTER connection, before subscribe → current durable authorization wins", async () => {
    const token = accessToken(VENDOR_OWNER_ID, "VENDOR_OWNER");
    const h = await connect({ bearer: token });
    await sharedIdentityRepo.updateRole(VENDOR_OWNER_ID, "CONSUMER");
    h.ws.send(
      JSON.stringify({ type: "subscribe_restaurant", restaurant_id: REST_ID }),
    );
    await new Promise((r) => setTimeout(r, 80));
    await broadcast(statusUpdate());
    await new Promise((r) => setTimeout(r, 80));
    expect(h.messages).toEqual([]);
  });

  it("WS-REV-1 connect active consumer, subscribe own order, suspend, broadcast → zero payload + revoked", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ bearer: token });
    h.ws.send(JSON.stringify({ type: "subscribe", order_id: ORDER_ID }));
    await new Promise((r) => setTimeout(r, 50));
    await sharedIdentityRepo.suspend(CONSUMER_ID, "revoked");
    await broadcast(statusUpdate());
    await new Promise((r) => setTimeout(r, 80));
    expect(h.messages).toEqual([]);
    if (h.closeCode === null) {
      await waitForClose(h).catch(() => undefined);
    }
    expect(h.closeCode).toBe(1008);
  });

  it("WS-REV-1b deletion after subscribe → zero payload + revoked", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ bearer: token });
    h.ws.send(JSON.stringify({ type: "subscribe", order_id: ORDER_ID }));
    await new Promise((r) => setTimeout(r, 50));
    sharedIdentityRepo._reset();
    await broadcast(statusUpdate());
    await new Promise((r) => setTimeout(r, 80));
    expect(h.messages).toEqual([]);
    if (h.closeCode === null) {
      await waitForClose(h).catch(() => undefined);
    }
    expect(h.closeCode).toBe(1008);
  });

  it("WS-REV-2 authorized vendor subscribe restaurant, then access loss → zero payload", async () => {
    await sharedUserRoleRepo.assign({
      user_id: VENDOR_STAFF_ID,
      scope_type: "restaurant",
      scope_id: REST_ID,
      role: "VENDOR_STAFF",
    });
    const token = accessToken(VENDOR_STAFF_ID, "VENDOR_STAFF");
    const h = await connect({ bearer: token });
    h.ws.send(
      JSON.stringify({ type: "subscribe_restaurant", restaurant_id: REST_ID }),
    );
    await new Promise((r) => setTimeout(r, 50));
    sharedUserRoleRepo._reset();
    await broadcast(statusUpdate());
    await new Promise((r) => setTimeout(r, 80));
    expect(h.messages).toEqual([]);
  });

  it("WS-REV-3 role changes after connection → cached JWT role cannot preserve old privilege", async () => {
    const token = accessToken(ADMIN_ID, "ADMIN");
    const h = await connect({ bearer: token });
    h.ws.send(JSON.stringify({ type: "subscribe", order_id: ORDER_ID }));
    await new Promise((r) => setTimeout(r, 50));
    await sharedIdentityRepo.updateRole(ADMIN_ID, "CONSUMER");
    await broadcast(statusUpdate());
    await new Promise((r) => setTimeout(r, 80));
    expect(h.messages).toEqual([]);
  });

  it("WS-REV-4 unchanged authorized principal → matching update still delivered", async () => {
    const token = accessToken(CONSUMER_ID, "CONSUMER");
    const h = await connect({ bearer: token });
    h.ws.send(JSON.stringify({ type: "subscribe", order_id: ORDER_ID }));
    await new Promise((r) => setTimeout(r, 50));
    await broadcast(statusUpdate());
    await waitUntil(() => h.messages.length > 0);
    expect(h.messages).toHaveLength(1);
  });
});
