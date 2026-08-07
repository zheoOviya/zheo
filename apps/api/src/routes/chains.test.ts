import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import {
  sharedAuditRepo,
  sharedChainRepo,
  sharedOrderRepo,
} from "../repositories/shared";
import { resetCatalogRepository } from "./catalog";
import type { OrderDTO } from "../repositories/orderRepository";

// ============================================
// V15 Multi-Outlet Dashboard - chain-level RBAC + aggregation
// ============================================

const CHAIN_ID = "c0000000-0000-4000-8000-000000000001";
const OTHER_CHAIN_ID = "c0000000-0000-4000-8000-000000000002";
const OWNER_ID = "00000000-0000-4000-8000-0000000000c1";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-0000000000c2";
const REST_ID = "a0000000-0000-4000-8000-000000000001";
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002";

function auth(role: string, userId: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId,
      phone: "+919876543210",
      role,
      device_fingerprint: "fp_chain_test_1234",
    })}`,
  };
}

function seedOrder(
  id: string,
  restaurantId: string,
  totalAmount: number,
  status: OrderDTO["status"],
): OrderDTO {
  return sharedOrderRepo._seed({
    id,
    user_id: OWNER_ID,
    restaurant_id: restaurantId,
    items: [],
    total_amount: totalAmount,
    status,
    commission_rate: 0.08,
    commission_amount: 0,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
  });
}

describe("V15 Multi-Outlet Dashboard", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedAuditRepo._reset();
    sharedChainRepo._reset();

    sharedChainRepo._seed(
      {
        id: CHAIN_ID,
        name: "SnakZap Mumbai Chain",
        owner_id: OWNER_ID,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      [REST_ID, GREEN_BOWL_ID],
    );
    sharedChainRepo._seed(
      {
        id: OTHER_CHAIN_ID,
        name: "Other Owner Chain",
        owner_id: OTHER_OWNER_ID,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      [REST_ID],
    );

    // Biryani House: 3 eligible (1400 total) + 1 DRAFT + 1 PAYMENT_FAILED
    seedOrder("o1", REST_ID, 500, "PICKED_UP");
    seedOrder("o2", REST_ID, 500, "PICKED_UP");
    seedOrder("o3", REST_ID, 400, "CONFIRMED");
    seedOrder("o4", REST_ID, 999, "DRAFT");
    seedOrder("o5", REST_ID, 999, "PAYMENT_FAILED");
    // Green Bowl: 2 eligible (500 total)
    seedOrder("o6", GREEN_BOWL_ID, 300, "PICKED_UP");
    seedOrder("o7", GREEN_BOWL_ID, 200, "SETTLED");

    app = createApp();
  });

  describe("RBAC on /api/vendor/chains/:chainId/aggregate-insights", () => {
    it("rejects requests with no token (401)", async () => {
      await request(app)
        .get(`/api/vendor/chains/${CHAIN_ID}/aggregate-insights`)
        .expect(401);
    });

    it("forbids VENDOR_STAFF (403)", async () => {
      const res = await request(app)
        .get(`/api/vendor/chains/${CHAIN_ID}/aggregate-insights`)
        .set(auth("VENDOR_STAFF", "00000000-0000-4000-8000-0000000000d1"))
        .expect(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("forbids CONSUMER (403)", async () => {
      await request(app)
        .get(`/api/vendor/chains/${CHAIN_ID}/aggregate-insights`)
        .set(auth("CONSUMER", "00000000-0000-4000-8000-0000000000d2"))
        .expect(403);
    });

    it("allows the Chain Owner (VENDOR_OWNER) and computes aggregates", async () => {
      const res = await request(app)
        .get(`/api/vendor/chains/${CHAIN_ID}/aggregate-insights`)
        .set(auth("VENDOR_OWNER", OWNER_ID))
        .expect(200);

      const d = res.body.data;
      expect(d.chain_id).toBe(CHAIN_ID);
      expect(d.chain_name).toBe("SnakZap Mumbai Chain");
      expect(d.outlet_count).toBe(2);
      // DRAFT + PAYMENT_FAILED excluded -> 3 + 2
      expect(d.total_orders).toBe(5);
      expect(d.total_revenue).toBe(1900);
      expect(d.combined_aov).toBe(380);

      const biryani = d.outlets.find(
        (o: { restaurant_id: string }) => o.restaurant_id === REST_ID,
      );
      const green = d.outlets.find(
        (o: { restaurant_id: string }) => o.restaurant_id === GREEN_BOWL_ID,
      );
      expect(biryani).toMatchObject({
        name: "Biryani House",
        order_count: 3,
        revenue: 1400,
        aov: 466.67,
        share: 73.68,
      });
      expect(green).toMatchObject({
        name: "Green Bowl",
        order_count: 2,
        revenue: 500,
        aov: 250,
        share: 26.32,
      });
      // shares sum to 100.00
      expect(
        Math.round(
          d.outlets.reduce((s: number, o: { share: number }) => s + o.share, 0) * 100,
        ) / 100,
      ).toBe(100);
    });

    it("forbids a VENDOR_OWNER reading a chain they do not own (403)", async () => {
      const res = await request(app)
        .get(`/api/vendor/chains/${CHAIN_ID}/aggregate-insights`)
        .set(auth("VENDOR_OWNER", OTHER_OWNER_ID))
        .expect(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("allows ADMIN on any chain (ownership bypass)", async () => {
      const res = await request(app)
        .get(`/api/vendor/chains/${OTHER_CHAIN_ID}/aggregate-insights`)
        .set(auth("ADMIN", "00000000-0000-4000-8000-0000000000e1"))
        .expect(200);
      expect(res.body.data.chain_name).toBe("Other Owner Chain");
    });

    it("returns 404 for an unknown chain", async () => {
      const res = await request(app)
        .get("/api/vendor/chains/c0000000-0000-4000-8000-00000000ffff/aggregate-insights")
        .set(auth("VENDOR_OWNER", OWNER_ID))
        .expect(404);
      expect(res.body.error.code).toBe("CHAIN_NOT_FOUND");
    });
  });

  describe("GET /api/vendor/chains (owner scope)", () => {
    it("lists only the chains the VENDOR_OWNER owns, with outlets", async () => {
      const res = await request(app)
        .get("/api/vendor/chains")
        .set(auth("VENDOR_OWNER", OWNER_ID))
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe("SnakZap Mumbai Chain");
      expect(res.body.data[0].outlets.map((o: { name: string }) => o.name)).toEqual([
        "Biryani House",
        "Green Bowl",
      ]);
    });

    it("forbids VENDOR_STAFF listing chains (403)", async () => {
      await request(app)
        .get("/api/vendor/chains")
        .set(auth("VENDOR_STAFF", "00000000-0000-4000-8000-0000000000d1"))
        .expect(403);
    });
  });
});
