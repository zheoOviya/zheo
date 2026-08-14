import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { jwtService } from "../services/jwt";
import { sharedKillSwitchRepo, sharedIdentityRepo, sharedSupportRepo, sharedRoleRepo, sharedOrderRepo, sharedPaymentRepo, sharedLoyaltyRepo } from "../repositories/shared";
import type { OrderDTO } from "../repositories/orderRepository";
import { resetRedisForTests } from "../lib/redis";

function adminToken(role: string) {
  return `Bearer ${jwtService.signAccessToken({
    sub: "admin-test-id",
    phone: "+919999999999",
    role,
    device_fingerprint: "fp_test_admin",
  })}`;
}

function consumerToken() {
  return `Bearer ${jwtService.signAccessToken({
    sub: "consumer-test-id",
    phone: "+918888888888",
    role: "CONSUMER",
    device_fingerprint: "fp_test_consumer",
  })}`;
}

describe("Admin RBAC (A-01, A-11)", () => {
  let app: Express;

  beforeAll(async () => {
    sharedKillSwitchRepo._reset();
    sharedRoleRepo._reset();
    app = createApp();
  });

  describe("Read-only endpoints (adminReadOnly)", () => {
    const readEndpoints = [
      { method: "get" as const, path: "/api/v1/admin/metrics" },
      { method: "get" as const, path: "/api/v1/admin/health" },
      { method: "get" as const, path: "/api/v1/admin/kill-switches" },
      { method: "get" as const, path: "/api/v1/admin/audit-logs" },
      { method: "get" as const, path: "/api/v1/admin/orders" },
      { method: "get" as const, path: "/api/v1/admin/vendors" },
      { method: "get" as const, path: "/api/v1/admin/vendors/metrics" },
      { method: "get" as const, path: "/api/v1/admin/revenue" },
    ];

    for (const ep of readEndpoints) {
      it(`OPS_AGENT gets 200 on ${ep.method.toUpperCase()} ${ep.path}`, async () => {
        const res = await request(app)[ep.method](ep.path).set("Authorization", adminToken("OPS_AGENT"));
        expect(res.status).toBe(200);
      });

      it(`ADMIN gets 200 on ${ep.method.toUpperCase()} ${ep.path}`, async () => {
        const res = await request(app)[ep.method](ep.path).set("Authorization", adminToken("ADMIN"));
        expect(res.status).toBe(200);
      });

      it(`SUPER_ADMIN gets 200 on ${ep.method.toUpperCase()} ${ep.path}`, async () => {
        const res = await request(app)[ep.method](ep.path).set("Authorization", adminToken("SUPER_ADMIN"));
        expect(res.status).toBe(200);
      });

      it(`CONSUMER gets 403 on ${ep.method.toUpperCase()} ${ep.path}`, async () => {
        const res = await request(app)[ep.method](ep.path).set("Authorization", consumerToken());
        expect(res.status).toBe(403);
      });
    }
  });

  describe("Write endpoints (adminWrite)", () => {
    it("OPS_AGENT gets 403 on PUT /admin/kill-switches/:id", async () => {
      const res = await request(app)
        .put("/api/v1/admin/kill-switches/vendor_churn_protection")
        .set("Authorization", adminToken("OPS_AGENT"))
        .send({ enabled: true });
      expect(res.status).toBe(403);
    });

    it("OPS_AGENT gets 403 on PUT /admin/vendors/:id/suspend", async () => {
      const res = await request(app)
        .put("/api/v1/admin/vendors/a0000000-0000-4000-8000-000000000001/suspend")
        .set("Authorization", adminToken("OPS_AGENT"));
      expect(res.status).toBe(403);
    });

    it("OPS_AGENT gets 403 on PUT /admin/vendors/:id/reactivate", async () => {
      const res = await request(app)
        .put("/api/v1/admin/vendors/a0000000-0000-4000-8000-000000000001/reactivate")
        .set("Authorization", adminToken("OPS_AGENT"));
      expect(res.status).toBe(403);
    });

    it("ADMIN can toggle kill switch", async () => {
      const res = await request(app)
        .put("/api/v1/admin/kill-switches/vendor_churn_protection")
        .set("Authorization", adminToken("ADMIN"))
        .send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
    });

    it("ADMIN can suspend a vendor", async () => {
      const res = await request(app)
        .put("/api/v1/admin/vendors/a0000000-0000-4000-8000-000000000001/suspend")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data.is_active).toBe(false);
    });

    it("ADMIN can reactivate a vendor", async () => {
      const res = await request(app)
        .put("/api/v1/admin/vendors/a0000000-0000-4000-8000-000000000001/reactivate")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data.is_active).toBe(true);
    });
  });

  describe("No auth returns 401", () => {
    it("GET /admin/metrics without token returns 401", async () => {
      const res = await request(app).get("/api/v1/admin/metrics");
      expect(res.status).toBe(401);
    });

    it("PUT /admin/kill-switches/:id without token returns 401", async () => {
      const res = await request(app)
        .put("/api/v1/admin/kill-switches/vendor_churn_protection")
        .send({ enabled: true });
      expect(res.status).toBe(401);
    });
  });

  describe("Metrics includes CAC/LTV (A-10)", () => {
    it("GET /admin/metrics returns cac/ltv fields", async () => {
      const res = await request(app)
        .get("/api/v1/admin/metrics")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data).toHaveProperty("cac_amount");
      expect(data).toHaveProperty("ltv_amount");
      expect(data).toHaveProperty("cac_ltv_ratio");
      expect(typeof data.cac_amount).toBe("number");
      expect(typeof data.ltv_amount).toBe("number");
      expect(typeof data.cac_ltv_ratio).toBe("number");
    });
  });

  describe("System Health (A-11)", () => {
    it("GET /admin/health reports storage mode, redis, uptime and latency", async () => {
      const res = await request(app)
        .get("/api/v1/admin/health")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.status).toBe("ok");
      expect(["postgres", "memory"]).toContain(data.storage_mode);
      expect(["reachable", "degraded", "memory"]).toContain(data.redis);
      expect(typeof data.uptime_seconds).toBe("number");
      expect(typeof data.latency_ms).toBe("number");
      expect(typeof data.timestamp).toBe("string");
    });
  });

  describe("Vendor suspend returns 409 when already suspended", () => {
    it("returns 409 when suspending an already suspended vendor", async () => {
      const res = await request(app)
        .put("/api/v1/admin/vendors/a0000000-0000-4000-8000-000000000003/suspend")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
    });
  });

  describe("Vendor reactivate returns 409 when already active", () => {
    it("returns 409 when reactivating an already active vendor", async () => {
      const res = await request(app)
        .put("/api/v1/admin/vendors/a0000000-0000-4000-8000-000000000001/reactivate")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
    });
  });

  // ============================================
  // Sprint 5.2: User Management (A-06)
  // ============================================

  describe("User Management (A-06)", () => {
    const TEST_USER_ID = "u-sprint52-test-000000000000001";
    const TEST_USER_PHONE = "+910000000001";

    beforeAll(async () => {
      sharedIdentityRepo._seed({
        id: TEST_USER_ID,
        phone: TEST_USER_PHONE,
        role: "CONSUMER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      sharedIdentityRepo._seed({
        id: "u-sprint52-admin-0000000000001",
        phone: "+910000000002",
        role: "ADMIN",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
    });

    it("GET /admin/users returns paginated user list", async () => {
      const res = await request(app)
        .get("/api/v1/admin/users")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("items");
      expect(res.body.data).toHaveProperty("total");
      expect(Array.isArray(res.body.data.items)).toBe(true);
    });

    it("GET /admin/users supports phone search", async () => {
      const res = await request(app)
        .get("/api/v1/admin/users?search=910000000001")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
    });

    it("GET /admin/users supports role filtering", async () => {
      const res = await request(app)
        .get("/api/v1/admin/users?role=ADMIN")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.items.every((u: { role: string }) => u.role === "ADMIN")).toBe(true);
    });

    it("PUT /admin/users/:id/suspend works for ADMIN", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/users/${TEST_USER_ID}/suspend`)
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data.is_suspended).toBe(true);
    });

    it("PUT /admin/users/:id/suspend returns 409 when already suspended", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/users/${TEST_USER_ID}/suspend`)
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(409);
    });

    it("PUT /admin/users/:id/reactivate works for ADMIN", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/users/${TEST_USER_ID}/reactivate`)
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data.is_suspended).toBe(false);
    });

    it("PUT /admin/users/:id/reactivate returns 409 when not suspended", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/users/${TEST_USER_ID}/reactivate`)
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(409);
    });

    it("OPS_AGENT gets 200 on GET /admin/users", async () => {
      const res = await request(app)
        .get("/api/v1/admin/users")
        .set("Authorization", adminToken("OPS_AGENT"));
      expect(res.status).toBe(200);
    });

    it("OPS_AGENT gets 403 on PUT /admin/users/:id/suspend", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/users/${TEST_USER_ID}/suspend`)
        .set("Authorization", adminToken("OPS_AGENT"));
      expect(res.status).toBe(403);
    });

    it("PUT /admin/users/:id/role changes role (SUPER_ADMIN)", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/users/${TEST_USER_ID}/role`)
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ role: "OPS_AGENT" });
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe("OPS_AGENT");
    });

    it("PUT /admin/users/:id/role blocked for ADMIN (not SUPER_ADMIN)", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/users/${TEST_USER_ID}/role`)
        .set("Authorization", adminToken("ADMIN"))
        .send({ role: "CONSUMER" });
      expect(res.status).toBe(403);
    });

    it("PUT /admin/users/:id/role blocked for OPS_AGENT", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/users/${TEST_USER_ID}/role`)
        .set("Authorization", adminToken("OPS_AGENT"))
        .send({ role: "CONSUMER" });
      expect(res.status).toBe(403);
    });

    it("PUT /admin/users/:id/role returns 400 for invalid role", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/users/${TEST_USER_ID}/role`)
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ role: "INVALID_ROLE" });
      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // Custom Roles (admin console) — SUPER_ADMIN only
  // ============================================

  describe("Role Management (custom roles)", () => {
    const CUSTOM_ROLE = "SUPPORT_LEAD";
    const CUSTOM_USER_ID = "u-custom-role-000000000001";
    const CUSTOM_USER_PHONE = "+910000000099";

    beforeEach(async () => {
      sharedRoleRepo._reset();
      resetRedisForTests();
    });

    it("GET /admin/roles lists built-in roles with member counts", async () => {
      const res = await request(app)
        .get("/api/v1/admin/roles")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const names = res.body.data.map((r: { name: string }) => r.name);
      expect(names).toContain("CONSUMER");
      expect(names).toContain("SUPER_ADMIN");
      for (const r of res.body.data) {
        expect(typeof r.member_count).toBe("number");
        expect(r.is_builtin).toBe(true);
      }
    });

    it("SUPER_ADMIN creates a custom role", async () => {
      const res = await request(app)
        .post("/api/v1/admin/roles")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({
          name: CUSTOM_ROLE,
          label: "Support Lead",
          description: "Leads the support pod",
          permissions: ["Triage tickets", "Escalate"],
        });
      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe(CUSTOM_ROLE);
      expect(res.body.data.is_builtin).toBe(false);
    });

    it("creating a role requires SUPER_ADMIN", async () => {
      const res = await request(app)
        .post("/api/v1/admin/roles")
        .set("Authorization", adminToken("ADMIN"))
        .send({
          name: "FINANCE",
          label: "Finance",
          description: "Finance team",
          permissions: ["View payouts"],
        });
      expect(res.status).toBe(403);
    });

    it("creating a duplicate or built-in role conflicts", async () => {
      await request(app)
        .post("/api/v1/admin/roles")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ name: CUSTOM_ROLE, label: "X", description: "y", permissions: [] })
        .expect(201);
      await request(app)
        .post("/api/v1/admin/roles")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ name: CUSTOM_ROLE, label: "X", description: "y", permissions: [] })
        .expect(409);
      await request(app)
        .post("/api/v1/admin/roles")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ name: "ADMIN", label: "X", description: "y", permissions: [] })
        .expect(409);
    });

    it("custom role appears in the catalog and can be assigned to a user", async () => {
      await request(app)
        .post("/api/v1/admin/roles")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ name: CUSTOM_ROLE, label: "Support Lead", description: "Support pod lead", permissions: ["Triage"] })
        .expect(201);

      sharedIdentityRepo._seed({
        id: CUSTOM_USER_ID,
        phone: CUSTOM_USER_PHONE,
        role: "CONSUMER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      const assign = await request(app)
        .put(`/api/v1/admin/users/${CUSTOM_USER_ID}/role`)
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ role: CUSTOM_ROLE });
      expect(assign.status).toBe(200);
      expect(assign.body.data.role).toBe(CUSTOM_ROLE);

      const list = await request(app)
        .get("/api/v1/admin/users?role=" + CUSTOM_ROLE)
        .set("Authorization", adminToken("ADMIN"));
      expect(list.status).toBe(200);
      expect(list.body.data.total).toBe(1);
    });

    it("cannot delete a built-in role or a role in use", async () => {
      await request(app)
        .post("/api/v1/admin/roles")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ name: CUSTOM_ROLE, label: "Support Lead", description: "Support pod lead", permissions: [] })
        .expect(201);

      await request(app)
        .delete("/api/v1/admin/roles/CONSUMER")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .expect(403);

      sharedIdentityRepo._seed({
        id: CUSTOM_USER_ID,
        phone: CUSTOM_USER_PHONE,
        role: CUSTOM_ROLE,
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      await request(app)
        .delete(`/api/v1/admin/roles/${CUSTOM_ROLE}`)
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .expect(409);
    });

    it("deletes an unused custom role", async () => {
      const roleName = "FINANCE";
      await request(app)
        .post("/api/v1/admin/roles")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ name: roleName, label: "Finance", description: "Finance team", permissions: ["View payouts"] })
        .expect(201);
      const res = await request(app)
        .delete(`/api/v1/admin/roles/${roleName}`)
        .set("Authorization", adminToken("SUPER_ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data.removed).toBe(roleName);
    });
  });

  // ============================================
  // A-08: Order Detail & Status Override
  // ============================================

  describe("Order Detail & Override (A-08)", () => {
    it("GET /admin/orders/:id returns 404 for unknown order", async () => {
      const res = await request(app)
        .get("/api/v1/admin/orders/nonexistent-order-id")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(404);
    });

    it("POST /admin/orders/:id/override-status blocked for ADMIN (not SUPER_ADMIN)", async () => {
      const res = await request(app)
        .post("/api/v1/admin/orders/test-order-id/override-status")
        .set("Authorization", adminToken("ADMIN"))
        .send({ status: "CANCELLED" });
      expect(res.status).toBe(403);
    });

    it("POST /admin/orders/:id/override-status blocked for OPS_AGENT", async () => {
      const res = await request(app)
        .post("/api/v1/admin/orders/test-order-id/override-status")
        .set("Authorization", adminToken("OPS_AGENT"))
        .send({ status: "CANCELLED" });
      expect(res.status).toBe(403);
    });

    it("POST /admin/orders/:id/override-status returns 404 for unknown order (SUPER_ADMIN)", async () => {
      const res = await request(app)
        .post("/api/v1/admin/orders/nonexistent-order-id/override-status")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ status: "CANCELLED" });
      expect(res.status).toBe(404);
    });

    it("POST /admin/orders/:id/override-status returns 400 for invalid status", async () => {
      const res = await request(app)
        .post("/api/v1/admin/orders/test-order-id/override-status")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ status: "INVALID" });
      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // Sprint 5.2: Support Tickets (A-07)
  // ============================================

  describe("Support Tickets (A-07)", () => {
    let ticketId: string;

    beforeAll(async () => {
      const ticket = await sharedSupportRepo.create({
        user_id: "u-sprint52-test-000000000000001",
        subject: "Test ticket for admin oversight",
        description: "This is a test support ticket.",
        priority: "HIGH",
        assignee: "OPS_AGENT",
      });
      ticketId = ticket.id;
    });

    it("GET /admin/support-tickets returns paginated list", async () => {
      const res = await request(app)
        .get("/api/v1/admin/support-tickets")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("items");
      expect(res.body.data).toHaveProperty("total");
      expect(Array.isArray(res.body.data.items)).toBe(true);
    });

    it("GET /admin/support-tickets supports status filter", async () => {
      const res = await request(app)
        .get("/api/v1/admin/support-tickets?status=OPEN")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      if (res.body.data.items.length > 0) {
        expect(res.body.data.items[0].status).toBe("OPEN");
      }
    });

    it("GET /admin/support-tickets supports priority filter", async () => {
      const res = await request(app)
        .get("/api/v1/admin/support-tickets?priority=HIGH")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      if (res.body.data.items.length > 0) {
        expect(res.body.data.items[0].priority).toBe("HIGH");
      }
    });

    it("PUT /admin/support-tickets/:id updates status", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/support-tickets/${ticketId}`)
        .set("Authorization", adminToken("ADMIN"))
        .send({ status: "IN_PROGRESS" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("IN_PROGRESS");
    });

    it("PUT /admin/support-tickets/:id returns 404 for nonexistent ticket", async () => {
      const res = await request(app)
        .put("/api/v1/admin/support-tickets/nonexistent-ticket-id")
        .set("Authorization", adminToken("ADMIN"))
        .send({ status: "RESOLVED" });
      expect(res.status).toBe(404);
    });

    it("OPS_AGENT gets 200 on GET /admin/support-tickets", async () => {
      const res = await request(app)
        .get("/api/v1/admin/support-tickets")
        .set("Authorization", adminToken("OPS_AGENT"));
      expect(res.status).toBe(200);
    });

    it("OPS_AGENT gets 403 on PUT /admin/support-tickets/:id", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/support-tickets/${ticketId}`)
        .set("Authorization", adminToken("OPS_AGENT"))
        .send({ status: "RESOLVED" });
      expect(res.status).toBe(403);
    });
  });

  // ============================================
  // A-12: Customer 360, Revenue Analytics, Vendor Metrics
  // ============================================

  describe("Customer 360 (A-12)", () => {
    const CUSTOMER_ID = "c360-test-0000000000000001";
    const CUSTOMER_PHONE = "+919999111111";
    const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";
    let settledOrderId: string;
    let ticketId: string;

    function orderSeed(id: string, status: OrderDTO["status"], total: number, commission: number, created: string) {
      return {
        id,
        user_id: CUSTOMER_ID,
        restaurant_id: RESTAURANT_ID,
        restaurant_name: "Test Cafe",
        items: [],
        total_amount: total,
        status,
        commission_rate: 0.1,
        commission_amount: commission,
        is_catering: false,
        headcount: null,
        pickup_otp: null,
        qr_token: null,
        checked_in: false,
        scheduled_pickup_time: null,
        created_at: created,
        updated_at: created,
      };
    }

    beforeAll(async () => {
      sharedIdentityRepo._reset();
      sharedOrderRepo._reset();
      sharedPaymentRepo._reset();
      sharedLoyaltyRepo._reset();
      sharedSupportRepo._reset();
      sharedIdentityRepo._seed({
        id: CUSTOMER_ID,
        phone: CUSTOMER_PHONE,
        role: "CONSUMER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      settledOrderId = "c360-order-0000000000000001";
      sharedOrderRepo._seed(orderSeed(settledOrderId, "SETTLED", 1200, 120, new Date().toISOString()));
      sharedOrderRepo._seed(orderSeed("c360-order-0000000000000002", "CANCELLED", 500, 0, new Date().toISOString()));
      sharedOrderRepo._seed(orderSeed("c360-order-0000000000000003", "PREPARING", 300, 30, new Date().toISOString()));
      await sharedPaymentRepo.create({
        order_id: settledOrderId,
        razorpay_order_id: "rp_c360",
        amount: 1200,
        method: "upi",
      });
      await sharedLoyaltyRepo.creditWallet(CUSTOMER_ID, 100, "referral_bonus");
      await sharedLoyaltyRepo.incrementStamp(CUSTOMER_ID, RESTAURANT_ID);
      await sharedLoyaltyRepo.recordClaim({
        claimant_user_id: "c360-claimant-0000000000000001",
        referrer_user_id: CUSTOMER_ID,
        referral_code: "SNKZ-TEST01",
        bonus_amount: 100,
        ip_address: "127.0.0.1",
        device_fingerprint: "fp-c360",
      });
      const ticket = await sharedSupportRepo.create({
        user_id: CUSTOMER_ID,
        subject: "Customer 360 ticket",
        description: "help needed",
        priority: "MEDIUM",
        assignee: null,
      });
      ticketId = ticket.id;
    });

    it("returns 404 for unknown user", async () => {
      const res = await request(app)
        .get("/api/v1/admin/customers/nonexistent-id/360")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(404);
    });

    it("CONSUMER gets 403", async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${CUSTOMER_ID}/360`)
        .set("Authorization", consumerToken());
      expect(res.status).toBe(403);
    });

    it("returns user profile, VIP, and summary", async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${CUSTOMER_ID}/360`)
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.user.id).toBe(CUSTOMER_ID);
      expect(d.user.phone).toBe(CUSTOMER_PHONE);
      expect(d.vip).toHaveProperty("is_vip");
      expect(d.vip).toHaveProperty("order_count");
      expect(d.summary.order_count).toBe(1);
      expect(d.summary.total_spend).toBe(1200);
      expect(d.summary.average_order_value).toBe(1200);
    });

    it("includes wallet, stamps, referrals, and tickets", async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${CUSTOMER_ID}/360`)
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.wallet.balance).toBe(100);
      expect(d.wallet_transactions.length).toBe(1);
      expect(d.wallet_transactions[0].reason).toBe("referral_bonus");
      expect(d.stamp_cards.length).toBe(1);
      expect(d.stamp_cards[0].stamp_count).toBe(1);
      expect(d.referral_code).toBeTruthy();
      expect(d.referrals_given.length).toBe(1);
      expect(d.referrals_given[0].referrer_user_id).toBe(CUSTOMER_ID);
      expect(d.tickets.length).toBe(1);
      expect(d.tickets[0].id).toBe(ticketId);
      expect(d.orders.length).toBe(3);
    });

    it("OPS_AGENT can read customer 360", async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${CUSTOMER_ID}/360`)
        .set("Authorization", adminToken("OPS_AGENT"));
      expect(res.status).toBe(200);
    });
  });

  describe("Revenue Analytics (A-12)", () => {
    const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";
    const REVENUE_USER = "rev-test-000000000000000001";

    function orderSeed(id: string, status: OrderDTO["status"], total: number, commission: number, daysAgo: number) {
      const created = new Date(Date.now() - daysAgo * 86400000).toISOString();
      return {
        id,
        user_id: REVENUE_USER,
        restaurant_id: RESTAURANT_ID,
        restaurant_name: "Test Cafe",
        items: [],
        total_amount: total,
        status,
        commission_rate: 0.1,
        commission_amount: commission,
        is_catering: false,
        headcount: null,
        pickup_otp: null,
        qr_token: null,
        checked_in: false,
        scheduled_pickup_time: null,
        created_at: created,
        updated_at: created,
      };
    }

    beforeAll(async () => {
      sharedOrderRepo._reset();
      sharedPaymentRepo._reset();
      const todaySettled = "rev-order-000000000000001";
      sharedOrderRepo._seed(orderSeed(todaySettled, "SETTLED", 1000, 100, 0));
      sharedOrderRepo._seed(orderSeed("rev-order-000000000000002", "PICKED_UP", 500, 50, 0));
      sharedOrderRepo._seed(orderSeed("rev-order-000000000000003", "SETTLED", 800, 80, 3));
      sharedOrderRepo._seed(orderSeed("rev-order-000000000000004", "CANCELLED", 9000, 0, 0));
      await sharedPaymentRepo.create({
        order_id: todaySettled,
        razorpay_order_id: "rp_rev_1",
        amount: 1000,
        method: "upi",
      });
    });

    it("returns 7-day series with totals and payment split", async () => {
      const res = await request(app)
        .get("/api/v1/admin/revenue")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.days).toBe(7);
      expect(d.series.length).toBe(7);
      expect(d.totals.orders).toBe(3);
      expect(d.totals.revenue).toBe(2300);
      expect(d.totals.commission).toBe(230);
      expect(d.payment_split.upi).toBe(1);
      expect(d.top_vendors.length).toBeGreaterThan(0);
      expect(d.top_vendors[0].name).toBeTruthy();
      // CANCELLED orders never count toward revenue
      expect(d.totals.revenue).toBe(2300);
    });

    it("respects the days query param", async () => {
      const res = await request(app)
        .get("/api/v1/admin/revenue?days=30")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data.days).toBe(30);
      expect(res.body.data.series.length).toBe(30);
    });

    it("clamps days to 30", async () => {
      const res = await request(app)
        .get("/api/v1/admin/revenue?days=999")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body.data.days).toBe(30);
    });

    it("CONSUMER gets 403", async () => {
      const res = await request(app)
        .get("/api/v1/admin/revenue")
        .set("Authorization", consumerToken());
      expect(res.status).toBe(403);
    });
  });

  describe("Vendor Metrics (A-09)", () => {
    const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";
    const VENDOR_USER = "vm-test-000000000000000001";

    beforeAll(async () => {
      sharedOrderRepo._reset();
      const created = new Date().toISOString();
      sharedOrderRepo._seed({
        id: "vm-order-000000000000001",
        user_id: VENDOR_USER,
        restaurant_id: RESTAURANT_ID,
        restaurant_name: "Test Cafe",
        items: [],
        total_amount: 400,
        status: "SETTLED",
        commission_rate: 0.1,
        commission_amount: 40,
        is_catering: false,
        headcount: null,
        pickup_otp: null,
        qr_token: null,
        checked_in: false,
        scheduled_pickup_time: null,
        created_at: created,
        updated_at: created,
      });
      sharedOrderRepo._seed({
        id: "vm-order-000000000000002",
        user_id: VENDOR_USER,
        restaurant_id: RESTAURANT_ID,
        restaurant_name: "Test Cafe",
        items: [],
        total_amount: 100,
        status: "PREPARING",
        commission_rate: 0.1,
        commission_amount: 10,
        is_catering: false,
        headcount: null,
        pickup_otp: null,
        qr_token: null,
        checked_in: false,
        scheduled_pickup_time: null,
        created_at: created,
        updated_at: created,
      });
    });

    it("returns per-vendor aggregates", async () => {
      const res = await request(app)
        .get("/api/v1/admin/vendors/metrics")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const rows = res.body.data;
      expect(Array.isArray(rows)).toBe(true);
      const vendor = rows.find((r: { id: string }) => r.id === RESTAURANT_ID);
      expect(vendor).toBeTruthy();
      expect(vendor.order_count).toBe(2);
      expect(vendor.completed_orders).toBe(1);
      expect(vendor.revenue).toBe(400);
      expect(vendor.commission).toBe(40);
      expect(vendor.active_orders).toBe(1);
      expect(vendor.owner_phone).toBeDefined();
    });

    it("sorts by revenue descending", async () => {
      const res = await request(app)
        .get("/api/v1/admin/vendors/metrics")
        .set("Authorization", adminToken("SUPER_ADMIN"));
      expect(res.status).toBe(200);
      const rows = res.body.data as { revenue: number }[];
      for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1]!;
        const curr = rows[i]!;
        expect(prev.revenue).toBeGreaterThanOrEqual(curr.revenue);
      }
    });
  });

  // ============================================
  // A-08: Order Detail enrichment (payment/customer/restaurant)
  // ============================================

  describe("Order Detail enrichment (A-08)", () => {
    const ORDER_ID = "od-enrich-000000000000001";
    const USER_ID = "od-user-000000000000000001";
    const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";

    beforeAll(async () => {
      sharedIdentityRepo._reset();
      sharedOrderRepo._reset();
      sharedPaymentRepo._reset();
      sharedIdentityRepo._seed({
        id: USER_ID,
        phone: "+919999000000",
        role: "CONSUMER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      const created = new Date().toISOString();
      sharedOrderRepo._seed({
        id: ORDER_ID,
        user_id: USER_ID,
        restaurant_id: RESTAURANT_ID,
        restaurant_name: "Test Cafe",
        items: [{ id: "od-item-000000000000001", menu_item_id: "m1", name: "Burger", base_price: 100, quantity: 2, customizations: [], customization_total: 0, item_subtotal: 200 }],
        total_amount: 200,
        status: "CONFIRMED",
        commission_rate: 0.1,
        commission_amount: 20,
        is_catering: false,
        headcount: null,
        pickup_otp: null,
        qr_token: null,
        checked_in: false,
        scheduled_pickup_time: null,
        created_at: created,
        updated_at: created,
      });
      await sharedPaymentRepo.create({
        order_id: ORDER_ID,
        razorpay_order_id: "rp_od",
        amount: 200,
        method: "card",
      });
    });

    it("returns payment, customer, and restaurant enrichment", async () => {
      const res = await request(app)
        .get(`/api/v1/admin/orders/${ORDER_ID}`)
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.payment.method).toBe("card");
      expect(d.payment.status).toBe("CREATED");
      expect(d.customer.phone).toBe("+919999000000");
      expect(d.customer.role).toBe("CONSUMER");
      expect(d.restaurant.name).toBe("Biryani House");
      expect(d.items[0].name).toBe("Burger");
      expect(d.commission_amount).toBe(20);
    });
  });
});
