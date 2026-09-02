import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
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
  DineInOrderWithItemsDTO,
  DineInTransactionRepos,
  DiningSessionDTO,
  RestaurantTableDTO,
} from "../repositories/dineInContracts";

// ============================================
// DINE-OPS1.2 vendor Dine-In kitchen-queue route
// GET /api/vendor/dine-in/orders?restaurant_id=<uuid>
// Read-only; table/session association is repository-derived.
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001"; // Biryani House
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002"; // Green Bowl
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner
const GREEN_OWNER_ID = "e0000000-0000-4000-a000-000000000002"; // Green Bowl owner
const STAFF_ID = "e0000000-0000-4000-a000-000000000099"; // scoped staff member
const CONSUMER_ID = "u00000000-0000-4000-8000-000000000001";

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
    owner_user_id: "u00000000-0000-4000-8000-000000000001",
    status: "OPEN",
    bill_requested_at: null,
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
  status: DineInOrderWithItemsDTO["status"],
  createdAt = "2026-08-24T10:05:00.000Z",
): DineInOrderWithItemsDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    placed_by: "u00000000-0000-4000-8000-000000000001",
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

function seedKitchenState() {
  const repos = sharedRepos();
  (repos.restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  })._seed(makeTable("t1", REST_ID, "T1"));
  (repos.restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  })._seed(makeTable("tg1", GREEN_BOWL_ID, "G1"));
  (repos.diningSessions as unknown as {
    _seed(s: DiningSessionDTO): DiningSessionDTO;
  })._seed(makeSession("s1", REST_ID, "t1"));
  (repos.diningSessions as unknown as {
    _seed(s: DiningSessionDTO): DiningSessionDTO;
  })._seed(makeSession("sg1", GREEN_BOWL_ID, "tg1"));
  (repos.dineInOrders as unknown as {
    _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
  })._seed(makeOrder("o1", REST_ID, "s1", "PLACED"));
  (repos.dineInOrders as unknown as {
    _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
  })._seed(makeOrder("o2", REST_ID, "s1", "READY_TO_SERVE"));
  (repos.dineInOrders as unknown as {
    _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
  })._seed(makeOrder("o3", REST_ID, "s1", "SERVED"));
  (repos.dineInOrders as unknown as {
    _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
  })._seed(makeOrder("g1", GREEN_BOWL_ID, "sg1", "PLACED"));
}

describe("Vendor Dine-In kitchen-queue route (DINE-OPS1.2)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    resetDineInState();
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
    app = createApp();
  });

  it("A. unauthorized (no token) is rejected at the vendor mount", async () => {
    await request(app)
      .get(`/api/vendor/dine-in/orders?restaurant_id=${REST_ID}`)
      .expect(401);
  });

  it("B. CONSUMER role is rejected at the vendor mount", async () => {
    await request(app)
      .get(`/api/vendor/dine-in/orders?restaurant_id=${REST_ID}`)
      .set(authHeaders(CONSUMER_ID, "CONSUMER"))
      .expect(403);
  });

  it("C. vendor without restaurant access gets FORBIDDEN", async () => {
    await request(app)
      .get(`/api/vendor/dine-in/orders?restaurant_id=${REST_ID}`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(403);
  });

  it("D. invalid restaurant_id is a VALIDATION_ERROR 400", async () => {
    const res = await request(app)
      .get("/api/vendor/dine-in/orders?restaurant_id=not-a-uuid")
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("E. authorized owner sees only their restaurant's actionable orders", async () => {
    seedKitchenState();
    const res = await request(app)
      .get(`/api/vendor/dine-in/orders?restaurant_id=${REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.error).toBeNull();
    const orders = res.body.data as Array<{
      id: string;
      status: string;
      session_id: string;
      total_amount: number;
      created_at: string;
      table: { id: string; label: string };
      items: Array<{ menu_item_id: string; name: string; quantity: number; item_subtotal: number }>;
    }>;
    expect(orders.map((o) => o.id).sort()).toEqual(["o1", "o2"]);
    // SERVED excluded; other restaurant's orders excluded.
    expect(orders.some((o) => o.id === "o3")).toBe(false);
    expect(orders.some((o) => o.id === "g1")).toBe(false);
    for (const order of orders) {
      expect(["PLACED", "PREPARING", "READY_TO_SERVE"]).toContain(order.status);
      expect(order.session_id).toBe("s1");
      expect(order.table).toEqual({ id: "t1", label: "T1" });
      const item = order.items[0]!;
      expect(item.name).toBe("Chicken Biryani");
      expect(item.menu_item_id).toBe("b0000000-0000-4000-8000-000000000001");
      expect(item.quantity).toBe(2);
      expect(item.item_subtotal).toBe(440);
      expect(order.total_amount).toBe(462);
    }
  });

  it("F. scoped staff member sees the same kitchen queue", async () => {
    seedKitchenState();
    sharedUserRoleRepo._seed({
      id: "ur-staff-1",
      user_id: STAFF_ID,
      scope_type: "restaurant",
      scope_id: REST_ID,
      role: "VENDOR_STAFF",
      created_at: "2026-08-24T00:00:00.000Z",
    });
    const res = await request(app)
      .get(`/api/vendor/dine-in/orders?restaurant_id=${REST_ID}`)
      .set(authHeaders(STAFF_ID, "VENDOR_STAFF"))
      .expect(200);
    expect(res.body.data.map((o: { id: string }) => o.id).sort()).toEqual(["o1", "o2"]);
  });

  it("G. cross-restaurant leakage is zero (Green Bowl owner queries own restaurant)", async () => {
    seedKitchenState();
    const res = await request(app)
      .get(`/api/vendor/dine-in/orders?restaurant_id=${GREEN_BOWL_ID}`)
      .set(authHeaders(GREEN_OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    const orders = res.body.data as Array<{ id: string }>;
    expect(orders.map((o) => o.id)).toEqual(["g1"]);
  });

  it("H. empty restaurant returns [] with 200", async () => {
    const res = await request(app)
      .get(`/api/vendor/dine-in/orders?restaurant_id=${REST_ID}`)
      .set(authHeaders(OWNER_ID, "VENDOR_OWNER"))
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it("I. ADMIN bypasses restaurant ownership", async () => {
    seedKitchenState();
    const res = await request(app)
      .get(`/api/vendor/dine-in/orders?restaurant_id=${GREEN_BOWL_ID}`)
      .set(authHeaders("00000000-0000-4000-8000-0000000000aa", "ADMIN"))
      .expect(200);
    expect(res.body.data.map((o: { id: string }) => o.id)).toEqual(["g1"]);
  });
});
