import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { jwtService } from "../services/jwt";
import { sharedKillSwitchRepo, sharedIdentityRepo, sharedSupportRepo, sharedRoleRepo } from "../repositories/shared";
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
});
