import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { jwtService } from "../services/jwt";
import { sharedKillSwitchRepo, sharedIdentityRepo, sharedSupportRepo, sharedRoleRepo, sharedOrderRepo, sharedPaymentRepo, sharedLoyaltyRepo, sharedAuditRepo, sharedVendorApplicationRepo, sharedNotificationRepo } from "../repositories/shared";
import type { OrderDTO } from "../repositories/orderRepository";
import type { OrderStatus } from "@snakzap/types";
import { resetRedisForTests } from "../lib/redis";
import { computeSettlementLine } from "../services/settlement";

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
      { method: "get" as const, path: "/api/v1/admin/notifications/metrics" },
      { method: "get" as const, path: "/api/v1/admin/notifications/health" },
      { method: "get" as const, path: "/api/v1/admin/notifications/age" },
      { method: "get" as const, path: "/api/v1/admin/notifications" },
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

  describe("Notification operability metrics (NOTIFICATION-OPERABILITY-A2)", () => {
    const USER_ID = "00000000-0000-4000-8000-0000000000a2";
    const FUTURE_AT = new Date("2999-01-01T00:00:00.000Z");

    function enqueueInput() {
      return {
        user_id: USER_ID,
        channel: "sms" as const,
        to_address: "+9100000000",
        body: "operability",
      };
    }

    let expectedOldest: string;

    beforeAll(async () => {
      sharedNotificationRepo._reset();
      // FAILED first (older + more attempts) so it is provably excluded from the
      // PENDING-only oldest/max extrema.
      const failed0 = await sharedNotificationRepo.enqueue(enqueueInput());
      const rf1 = await sharedNotificationRepo.reserveAttempt(failed0.id, 0, new Date());
      await sharedNotificationRepo.markRetryable(failed0.id, rf1!.attempts, "e1", new Date(0));
      const rf2 = await sharedNotificationRepo.reserveAttempt(failed0.id, 1, new Date());
      await sharedNotificationRepo.markDead(failed0.id, rf2!.attempts, "dead");

      await new Promise<void>((r) => setTimeout(r, 5));
      const due = await sharedNotificationRepo.enqueue(enqueueInput());

      const future0 = await sharedNotificationRepo.enqueue(enqueueInput());
      const rfu = await sharedNotificationRepo.reserveAttempt(future0.id, 0, new Date());
      const future = (await sharedNotificationRepo.markRetryable(
        future0.id,
        rfu!.attempts,
        "later",
        FUTURE_AT,
      ))!;

      const sent0 = await sharedNotificationRepo.enqueue(enqueueInput());
      const rs = await sharedNotificationRepo.reserveAttempt(sent0.id, 0, new Date());
      await sharedNotificationRepo.markSent(sent0.id, rs!.attempts);

      expectedOldest = [due.created_at, future.created_at].sort()[0]!;
    });

    afterAll(() => {
      sharedNotificationRepo._reset();
    });

    it("O13: adminReadOnly caller gets 200 with the exact PII-free shape", async () => {
      const res = await request(app)
        .get("/api/v1/admin/notifications/metrics")
        .set("Authorization", adminToken("OPS_AGENT"));
      expect(res.status).toBe(200);
      // Exact object equality: extra/missing/renamed keys all fail.
      expect(res.body.data).toEqual({
        pending_total: 2,
        due_pending: 1,
        future_retry: 1,
        failed_total: 1,
        sent_total: 1,
        oldest_pending_at: expectedOldest,
        oldest_pending_age_seconds: expect.any(Number),
        max_attempt_pending: 1,
      });
      expect(Number.isInteger(res.body.data.oldest_pending_age_seconds)).toBe(true);
      expect(res.body.data.oldest_pending_age_seconds as number).toBeGreaterThanOrEqual(0);
    });

    it("O14: unauthorised and unauthenticated callers are denied by existing auth", async () => {
      const forbidden = await request(app)
        .get("/api/v1/admin/notifications/metrics")
        .set("Authorization", consumerToken());
      expect(forbidden.status).toBe(403);
      const unauthenticated = await request(app).get("/api/v1/admin/notifications/metrics");
      expect(unauthenticated.status).toBe(401);
    });

    it("O15: response contains no body/to_address/last_error/user_id", async () => {
      const res = await request(app)
        .get("/api/v1/admin/notifications/metrics")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      for (const forbidden of ["body", "to_address", "last_error", "user_id"]) {
        expect(res.body.data).not.toHaveProperty(forbidden);
      }
      expect(JSON.stringify(res.body)).not.toMatch(/\+91|@example\.com/);
    });

    it("O16: failure_rate/success_rate/delivery_rate absent", async () => {
      const res = await request(app)
        .get("/api/v1/admin/notifications/metrics")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      for (const forbidden of ["failure_rate", "success_rate", "delivery_rate"]) {
        expect(res.body.data).not.toHaveProperty(forbidden);
      }
    });

    it("introduces no notification mutation endpoint", async () => {
      const mutations = [
        request(app)
          .post("/api/v1/admin/notifications/retry")
          .set("Authorization", adminToken("SUPER_ADMIN")),
        request(app)
          .post("/api/v1/admin/notifications/reset")
          .set("Authorization", adminToken("SUPER_ADMIN")),
        request(app)
          .delete("/api/v1/admin/notifications/x")
          .set("Authorization", adminToken("SUPER_ADMIN")),
      ];
      for (const m of mutations) {
        const res = await m;
        expect(res.status).toBe(404);
      }
    });
  });

  describe("Notification operability age clamp (NOTIFICATION-OPERABILITY-A2)", () => {
    it("O8: age uses the same now and never returns negative", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const t0 = new Date("2026-06-01T12:00:00.000Z");
        vi.setSystemTime(t0);
        sharedNotificationRepo._reset();
        await sharedNotificationRepo.enqueue({
          user_id: "00000000-0000-4000-8000-0000000000a2",
          channel: "email",
          to_address: "owner@example.com",
          body: "age",
        });
        // Rewind the clock so the stored created_at is in the future; the age
        // must clamp to 0 rather than go negative.
        vi.setSystemTime(new Date(t0.getTime() - 5000));
        const token = adminToken("ADMIN");
        const res = await request(app)
          .get("/api/v1/admin/notifications/metrics")
          .set("Authorization", token);
        expect(res.status).toBe(200);
        expect(res.body.data.oldest_pending_at).toBe(t0.toISOString());
        expect(res.body.data.oldest_pending_age_seconds).toBe(0);
      } finally {
        vi.useRealTimers();
      }
      sharedNotificationRepo._reset();
    });
  });

  describe("Notification operability health (NOTIFICATION-OPERABILITY-READMODEL-A2)", () => {
    const USER_ID = "00000000-0000-4000-8000-0000000000b2";
    const TO_ADDRESS = "operator-probe@example.com";
    const BODY_TEXT = "RAW_BODY_MUST_NOT_LEAK";
    const FUTURE_AT = new Date("2999-01-01T00:00:00.000Z");
    const RAW_UNKNOWN_ERROR = "RAW_PROVIDER_SECRET_TEXT";
    const RAW_CONFIG_ERROR_SMS = "sms provider not configured";
    const RAW_CONFIG_ERROR_EMAIL = "email provider not configured";

    const EXPECTED_CHANNELS = [
      { channel: "email", pending: 1, due: 0, failed: 2, sent: 0 },
      { channel: "sms", pending: 2, due: 1, failed: 1, sent: 1 },
    ];
    const EXPECTED_FAILURE_CATEGORIES = [
      { channel: "email", safe_error_category: "PROVIDER_UNCONFIGURED", count: 1 },
      { channel: "email", safe_error_category: "UNKNOWN", count: 2 },
      { channel: "sms", safe_error_category: "PROVIDER_UNCONFIGURED", count: 1 },
      { channel: "sms", safe_error_category: "UNKNOWN", count: 1 },
    ];

    function enqueueFor(channel: "sms" | "email") {
      return sharedNotificationRepo.enqueue({
        user_id: USER_ID,
        channel,
        to_address: TO_ADDRESS,
        body: BODY_TEXT,
      });
    }

    async function driveToFailed(channel: "sms" | "email", error: string) {
      const n = await enqueueFor(channel);
      const r = await sharedNotificationRepo.reserveAttempt(n.id, 0, new Date());
      return (await sharedNotificationRepo.markDead(n.id, r!.attempts, error))!;
    }

    async function driveToRetry(channel: "sms" | "email", error: string, next: Date) {
      const n = await enqueueFor(channel);
      const r = await sharedNotificationRepo.reserveAttempt(n.id, 0, new Date());
      return (await sharedNotificationRepo.markRetryable(n.id, r!.attempts, error, next))!;
    }

    async function driveToSent(channel: "sms" | "email") {
      const n = await enqueueFor(channel);
      const r = await sharedNotificationRepo.reserveAttempt(n.id, 0, new Date());
      return (await sharedNotificationRepo.markSent(n.id, r!.attempts))!;
    }

    function collectKeys(value: unknown, keys: Set<string>): void {
      if (Array.isArray(value)) {
        for (const v of value) collectKeys(v, keys);
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          collectKeys(v, keys);
        }
      }
    }

    async function getHealth() {
      return request(app)
        .get("/api/v1/admin/notifications/health")
        .set("Authorization", adminToken("OPS_AGENT"));
    }

    beforeAll(async () => {
      sharedNotificationRepo._reset();
      await enqueueFor("sms");
      await driveToRetry("sms", RAW_UNKNOWN_ERROR, FUTURE_AT);
      await driveToFailed("sms", RAW_CONFIG_ERROR_SMS);
      await driveToSent("sms");
      await driveToRetry("email", RAW_UNKNOWN_ERROR, FUTURE_AT);
      await driveToFailed("email", RAW_CONFIG_ERROR_EMAIL);
      await driveToFailed("email", RAW_UNKNOWN_ERROR);
    });

    afterAll(() => {
      sharedNotificationRepo._reset();
    });

    it("A1: admin can GET /api/v1/admin/notifications/health", async () => {
      const res = await getHealth();
      expect(res.status).toBe(200);
    });

    it("A2: non-admin and unauthenticated callers are denied under existing policy", async () => {
      const forbidden = await request(app)
        .get("/api/v1/admin/notifications/health")
        .set("Authorization", consumerToken());
      expect(forbidden.status).toBe(403);
      const unauthenticated = await request(app).get("/api/v1/admin/notifications/health");
      expect(unauthenticated.status).toBe(401);
    });

    it("A3: response is aggregate-only with the exact deterministic shape", async () => {
      const res = await getHealth();
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(["channels", "failure_categories"]);
      expect(res.body.data.channels).toHaveLength(2);
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      expect([...keys].sort()).toEqual(
        [
          "channel",
          "channels",
          "count",
          "due",
          "failed",
          "failure_categories",
          "pending",
          "safe_error_category",
          "sent",
        ].sort(),
      );
    });

    it("A4: channel pending/due/failed/sent counts are exact", async () => {
      const res = await getHealth();
      expect(res.body.data.channels).toEqual(EXPECTED_CHANNELS);
    });

    it("A5: failure-category counts are exact", async () => {
      const res = await getHealth();
      expect(res.body.data.failure_categories).toEqual(EXPECTED_FAILURE_CATEGORIES);
    });

    it("A6: PROVIDER_UNCONFIGURED is exposed safely as a closed-enum value", async () => {
      const res = await getHealth();
      const row = res.body.data.failure_categories.find(
        (c: { channel: string; safe_error_category: string }) =>
          c.channel === "sms" && c.safe_error_category === "PROVIDER_UNCONFIGURED",
      );
      expect(row).toEqual({
        channel: "sms",
        safe_error_category: "PROVIDER_UNCONFIGURED",
        count: 1,
      });
    });

    it("A7: UNKNOWN fallback is exposed safely", async () => {
      const res = await getHealth();
      const row = res.body.data.failure_categories.find(
        (c: { channel: string; safe_error_category: string }) => c.safe_error_category === "UNKNOWN",
      );
      expect(row).toBeDefined();
      expect(["PROVIDER_UNCONFIGURED", "UNKNOWN"]).toContain(row.safe_error_category);
    });

    it("A8: raw last_error is absent", async () => {
      const res = await getHealth();
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("last_error");
      for (const raw of [RAW_UNKNOWN_ERROR, RAW_CONFIG_ERROR_SMS, RAW_CONFIG_ERROR_EMAIL]) {
        expect(serialized).not.toContain(raw);
      }
    });

    it("A9: to_address is absent", async () => {
      const res = await getHealth();
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      expect([...keys]).not.toContain("to_address");
      expect(JSON.stringify(res.body)).not.toContain(TO_ADDRESS);
    });

    it("A10: body is absent", async () => {
      const res = await getHealth();
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      expect([...keys]).not.toContain("body");
      expect(JSON.stringify(res.body)).not.toContain(BODY_TEXT);
    });

    it("A11: user_id is absent", async () => {
      const res = await getHealth();
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      expect([...keys]).not.toContain("user_id");
      expect(JSON.stringify(res.body)).not.toContain(USER_ID);
    });

    it("A12: no notification id is present", async () => {
      const res = await getHealth();
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      expect([...keys]).not.toContain("id");
      expect([...keys]).not.toContain("notification_id");
      expect(JSON.stringify(res.body)).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
    });

    it("A13: no failure/success/delivery rate field exists", async () => {
      const res = await getHealth();
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      for (const forbidden of ["failure_rate", "success_rate", "delivery_rate", "rate"]) {
        expect([...keys]).not.toContain(forbidden);
      }
    });

    it("A14: no SLA state exists", async () => {
      const res = await getHealth();
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      for (const forbidden of [
        "sla",
        "sla_status",
        "health_state",
        "healthy",
        "unhealthy",
        "breached",
        "warning",
        "critical",
      ]) {
        expect([...keys]).not.toContain(forbidden);
      }
    });

    it("A15: no age buckets exist", async () => {
      const res = await getHealth();
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      for (const forbidden of [
        "age",
        "age_bucket",
        "age_buckets",
        "oldest_pending_at",
        "oldest_pending_age_seconds",
      ]) {
        expect([...keys]).not.toContain(forbidden);
      }
    });

    it("A16: existing /notifications/metrics 8-key contract is unchanged", async () => {
      const res = await request(app)
        .get("/api/v1/admin/notifications/metrics")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(
        [
          "pending_total",
          "due_pending",
          "future_retry",
          "failed_total",
          "sent_total",
          "oldest_pending_at",
          "oldest_pending_age_seconds",
          "max_attempt_pending",
        ].sort(),
      );
      expect(Number.isInteger(res.body.data.oldest_pending_age_seconds)).toBe(true);
      expect(res.body.data.oldest_pending_age_seconds).toBeGreaterThanOrEqual(0);
      expect(res.body.data.pending_total).toBe(3);
      expect(res.body.data.failed_total).toBe(3);
    });

    it("A17: route performs no state mutation", async () => {
      const before = JSON.stringify(await sharedNotificationRepo.listAll());
      const res = await getHealth();
      expect(res.status).toBe(200);
      expect(JSON.stringify(await sharedNotificationRepo.listAll())).toBe(before);
    });

    it("A18: no inspection pagination or cursor is introduced", async () => {
      const res = await getHealth();
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      for (const forbidden of ["cursor", "next_cursor", "page", "limit", "offset", "items", "has_more"]) {
        expect([...keys]).not.toContain(forbidden);
      }
    });
  });

  describe("Notification inspection (NOTIFICATION-OPERABILITY-INSPECTION-A2)", () => {
    const USER_ID = "00000000-0000-4000-8000-0000000000c2";
    const TO_ADDRESS = "recipient-secret@example.com";
    const BODY_TEXT = "body-secret";
    const RAW_ERROR = "raw-error-secret";
    const SMS_CONFIG = "sms provider not configured";
    const FUTURE_AT = new Date("2999-01-01T00:00:00.000Z");
    const GENERIC_PER_CHANNEL = 26;
    const SAFE_ITEM_KEYS = [
      "attempts",
      "channel",
      "created_at",
      "id",
      "next_attempt_at",
      "safe_error_category",
      "status",
    ];

    function enqueueInput(channel: "sms" | "email") {
      return { user_id: USER_ID, channel, to_address: TO_ADDRESS, body: BODY_TEXT };
    }

    function getInspect(query = "") {
      const suffix = query ? `?${query}` : "";
      return request(app)
        .get(`/api/v1/admin/notifications${suffix}`)
        .set("Authorization", adminToken("ADMIN"));
    }

    function collectKeys(value: unknown, keys: Set<string>): void {
      if (Array.isArray(value)) {
        for (const v of value) collectKeys(v, keys);
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          collectKeys(v, keys);
        }
      }
    }

    async function pageAllIds(query: string): Promise<string[]> {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 100; guard += 1) {
        const q = cursor ? `${query}&cursor=${encodeURIComponent(cursor)}` : query;
        const res = await getInspect(q);
        expect(res.status).toBe(200);
        ids.push(...res.body.data.items.map((i: { id: string }) => i.id));
        cursor = res.body.data.next_cursor;
        if (!cursor) return ids;
      }
      throw new Error("pagination did not terminate");
    }

    beforeAll(async () => {
      // Reset the in-memory rate-limit window: this block issues a bounded but
      // non-trivial number of requests (full pagination walks) and must not
      // exhaust the shared per-IP budget for downstream blocks.
      resetRedisForTests();
      sharedNotificationRepo._reset();
      for (let i = 0; i < GENERIC_PER_CHANNEL; i += 1) {
        await sharedNotificationRepo.enqueue(enqueueInput("sms"));
      }
      for (let i = 0; i < GENERIC_PER_CHANNEL; i += 1) {
        await sharedNotificationRepo.enqueue(enqueueInput("email"));
      }
      const failed = await sharedNotificationRepo.enqueue(enqueueInput("email"));
      const rf = await sharedNotificationRepo.reserveAttempt(failed.id, 0, new Date());
      await sharedNotificationRepo.markDead(failed.id, rf!.attempts, SMS_CONFIG);
      const future = await sharedNotificationRepo.enqueue(enqueueInput("sms"));
      const rfu = await sharedNotificationRepo.reserveAttempt(future.id, 0, new Date());
      await sharedNotificationRepo.markRetryable(future.id, rfu!.attempts, RAW_ERROR, FUTURE_AT);
      const sent = await sharedNotificationRepo.enqueue(enqueueInput("sms"));
      const rs = await sharedNotificationRepo.reserveAttempt(sent.id, 0, new Date());
      await sharedNotificationRepo.markSent(sent.id, rs!.attempts);
    });

    afterAll(() => {
      sharedNotificationRepo._reset();
      resetRedisForTests();
    });

    it("O23: default response is the exact bounded projection with no total/offset and a cursor only when more rows exist", async () => {
      const res = await getInspect();
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(["items", "next_cursor"]);
      expect(res.body.data.items).toHaveLength(50); // DEFAULT_LIMIT
      expect(res.body.data.next_cursor).toEqual(expect.any(String));
      expect(res.body.data).not.toHaveProperty("total");
      expect(res.body.data).not.toHaveProperty("has_more");
      expect(res.body.data).not.toHaveProperty("page");
      expect(res.body.data).not.toHaveProperty("offset");
      for (const item of res.body.data.items) {
        expect(Object.keys(item).sort()).toEqual(SAFE_ITEM_KEYS);
      }

      // The full walk is ordered created_at ASC, id ASC and complete.
      const direct = await sharedNotificationRepo.listForOperabilityInspection({
        now: new Date(),
        limit: 200,
        due: "all",
      });
      expect(direct.items).toHaveLength(GENERIC_PER_CHANNEL * 2 + 3);
      expect(await pageAllIds("limit=20")).toEqual(direct.items.map((i) => i.id));
    });

    it("O24: response carries no recipient/body/raw-error/user/idempotency material", async () => {
      const res = await getInspect("limit=200");
      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      for (const secret of [TO_ADDRESS, BODY_TEXT, RAW_ERROR, SMS_CONFIG]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain("+91");
      const keys = new Set<string>();
      collectKeys(res.body.data.items, keys);
      for (const forbidden of ["user_id", "to_address", "body", "last_error", "idempotency"]) {
        expect([...keys]).not.toContain(forbidden);
      }
      // The closed-enum category is the only failure signal exposed.
      expect([...keys]).toContain("safe_error_category");
    });

    it("O25: status/channel/due/safe-category filters are exact and invalid values are 400", async () => {
      const ids = (res: request.Response) =>
        res.body.data.items.map((i: { id: string }) => i.id) as string[];

      const pending = await getInspect("limit=200&status=PENDING");
      expect(ids(pending)).toHaveLength(GENERIC_PER_CHANNEL * 2 + 1);
      expect(pending.body.data.items.every((i: { status: string }) => i.status === "PENDING")).toBe(true);

      const failed = await getInspect("limit=200&status=FAILED");
      expect(ids(failed)).toHaveLength(1);
      expect(failed.body.data.items[0].status).toBe("FAILED");

      const email = await getInspect("limit=200&channel=email");
      expect(ids(email)).toHaveLength(GENERIC_PER_CHANNEL + 1);
      expect(email.body.data.items.every((i: { channel: string }) => i.channel === "email")).toBe(true);

      const smsPending = await getInspect("limit=200&channel=sms&status=PENDING");
      expect(ids(smsPending)).toHaveLength(GENERIC_PER_CHANNEL + 1);

      const future = await getInspect("limit=200&due=future");
      expect(ids(future)).toHaveLength(1);
      expect(future.body.data.items[0].status).toBe("PENDING");

      const due = await getInspect("limit=200&due=due");
      expect(ids(due)).toHaveLength(GENERIC_PER_CHANNEL * 2);

      const unknown = await getInspect("limit=200&safe_error_category=UNKNOWN");
      expect(ids(unknown)).toHaveLength(1);
      expect(unknown.body.data.items[0].safe_error_category).toBe("UNKNOWN");

      const unconfigured = await getInspect("limit=200&safe_error_category=PROVIDER_UNCONFIGURED");
      expect(ids(unconfigured)).toHaveLength(1);
      expect(unconfigured.body.data.items[0].safe_error_category).toBe("PROVIDER_UNCONFIGURED");

      const invalidQueries = [
        "limit=0",
        "limit=201",
        "limit=abc",
        "limit=1.5",
        "limit=-1",
        "limit=",
        "limit=1&limit=2",
        "status=BOGUS",
        "status=PENDING&status=SENT",
        "channel=push",
        "due=soon",
        "safe_error_category=NOPE",
        "cursor=@@@not-a-cursor@@@",
      ];
      for (const query of invalidQueries) {
        const res = await getInspect(query);
        expect(res.status, query).toBe(400);
        expect(res.body.error.code, query).toBe("VALIDATION_ERROR");
      }
    });

    it("O27 (route): the opaque cursor pages exactly once through the full ordered set", async () => {
      const first = await getInspect("limit=13");
      expect(first.body.data.items).toHaveLength(13);
      expect(first.body.data.next_cursor).toEqual(expect.any(String));

      const walked = await pageAllIds("limit=13");
      const direct = await sharedNotificationRepo.listForOperabilityInspection({
        now: new Date(),
        limit: 200,
        due: "all",
      });
      expect(walked).toEqual(direct.items.map((i) => i.id));
      expect(new Set(walked).size).toBe(walked.length);

      // A cursor produced under a filter stays scoped to that filter.
      const filtered = await getInspect("limit=5&status=PENDING");
      const follow = await getInspect(
        `limit=5&status=PENDING&cursor=${encodeURIComponent(filtered.body.data.next_cursor)}`,
      );
      expect(follow.status).toBe(200);
      expect(follow.body.data.items.every((i: { status: string }) => i.status === "PENDING")).toBe(true);
      const overlap = new Set(filtered.body.data.items.map((i: { id: string }) => i.id));
      expect(follow.body.data.items.some((i: { id: string }) => overlap.has(i.id))).toBe(false);
    });
  });

  describe("Notification backlog age distribution (NOTIFICATION-OPERABILITY-AGE-TRUTH-A2)", () => {
    const USER_ID = "00000000-0000-4000-8000-0000000000d2";
    const TO_ADDRESS = "age-probe@example.com";
    const BODY_TEXT = "age-body-secret";
    const RAW_ERROR = "age-raw-provider-secret";
    const EXPECTED_BUCKETS = ["lt_1m", "m1_to_lt_5m", "m5_to_lt_15m", "gte_15m"];
    const EXPECTED_META = [
      { bucket: "lt_1m", min_age_seconds: 0, max_age_seconds: 60 },
      { bucket: "m1_to_lt_5m", min_age_seconds: 60, max_age_seconds: 300 },
      { bucket: "m5_to_lt_15m", min_age_seconds: 300, max_age_seconds: 900 },
      { bucket: "gte_15m", min_age_seconds: 900, max_age_seconds: null },
    ];
    const BUCKET_KEYS_4 = ["bucket", "count", "max_age_seconds", "min_age_seconds"];
    const PENDING_COUNT = 5;

    function enqueueInput(channel: "sms" | "email") {
      return { user_id: USER_ID, channel, to_address: TO_ADDRESS, body: BODY_TEXT };
    }

    function getAge() {
      return request(app)
        .get("/api/v1/admin/notifications/age")
        .set("Authorization", adminToken("OPS_AGENT"));
    }

    function collectKeys(value: unknown, keys: Set<string>): void {
      if (Array.isArray(value)) {
        for (const v of value) collectKeys(v, keys);
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          collectKeys(v, keys);
        }
      }
    }

    beforeAll(async () => {
      resetRedisForTests();
      sharedNotificationRepo._reset();
      // Freshly enqueued rows have created_at ~= now, so every PENDING row is
      // well inside the youngest (<60s) bucket. Terminal rows must be excluded.
      for (let i = 0; i < PENDING_COUNT; i += 1) {
        await sharedNotificationRepo.enqueue(enqueueInput(i % 2 === 0 ? "sms" : "email"));
      }
      const dead = await sharedNotificationRepo.enqueue(enqueueInput("sms"));
      const rd = await sharedNotificationRepo.reserveAttempt(dead.id, 0, new Date());
      await sharedNotificationRepo.markDead(dead.id, rd!.attempts, RAW_ERROR);
      const sent = await sharedNotificationRepo.enqueue(enqueueInput("email"));
      const rs = await sharedNotificationRepo.reserveAttempt(sent.id, 0, new Date());
      await sharedNotificationRepo.markSent(sent.id, rs!.attempts);
    });

    afterAll(() => {
      sharedNotificationRepo._reset();
      resetRedisForTests();
    });

    it("O33-K: requires adminReadOnly (OPS_AGENT 200, CONSUMER 403, anonymous 401)", async () => {
      const ops = await getAge();
      expect(ops.status).toBe(200);

      const admin = await request(app)
        .get("/api/v1/admin/notifications/age")
        .set("Authorization", adminToken("ADMIN"));
      expect(admin.status).toBe(200);

      const consumer = await request(app)
        .get("/api/v1/admin/notifications/age")
        .set("Authorization", consumerToken());
      expect(consumer.status).toBe(403);

      const anonymous = await request(app).get("/api/v1/admin/notifications/age");
      expect(anonymous.status).toBe(401);
    });

    it("O33-L: the response leaks no recipient/body/raw-error/user/idempotency material", async () => {
      const res = await getAge();
      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      for (const secret of [USER_ID, TO_ADDRESS, BODY_TEXT, RAW_ERROR]) {
        expect(serialized).not.toContain(secret);
      }
      const keys = new Set<string>();
      collectKeys(res.body.data, keys);
      for (const forbidden of ["user_id", "to_address", "body", "last_error", "idempotency", "id"]) {
        expect([...keys]).not.toContain(forbidden);
      }
      expect([...keys].sort()).toEqual([
        "bucket",
        "buckets",
        "count",
        "max_age_seconds",
        "min_age_seconds",
        "pending_total",
      ]);
    });

    it("O33-M: response is frozen to buckets[] + pending_total with four ordered keys", async () => {
      const res = await getAge();
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(["buckets", "pending_total"]);
      expect(res.body.data.buckets.map((b: { bucket: string }) => b.bucket)).toEqual(EXPECTED_BUCKETS);
      const meta = res.body.data.buckets.map(
        (b: { bucket: string; min_age_seconds: number; max_age_seconds: number | null }) => ({
          bucket: b.bucket,
          min_age_seconds: b.min_age_seconds,
          max_age_seconds: b.max_age_seconds,
        }),
      );
      expect(meta).toEqual(EXPECTED_META);
      for (const bucket of res.body.data.buckets) {
        expect(Object.keys(bucket).sort()).toEqual(BUCKET_KEYS_4);
        expect(Number.isInteger(bucket.count)).toBe(true);
        expect(bucket.count).toBeGreaterThanOrEqual(0);
      }
      const serialized = JSON.stringify(res.body).toLowerCase();
      for (const forbidden of ["sla", "breach", "severity", "alert", "warning", "critical", "overdue"]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it("O33-N: aggregate-only counts are truthful, sum-invariant, and mutation-free", async () => {
      const first = await getAge();
      expect(first.status).toBe(200);
      expect(first.body.data.pending_total).toBe(PENDING_COUNT);
      const counts = Object.fromEntries(
        first.body.data.buckets.map((b: { bucket: string; count: number }) => [b.bucket, b.count]),
      );
      expect(counts).toEqual({ lt_1m: PENDING_COUNT, m1_to_lt_5m: 0, m5_to_lt_15m: 0, gte_15m: 0 });
      const sum = first.body.data.buckets.reduce(
        (acc: number, b: { count: number }) => acc + b.count,
        0,
      );
      expect(sum).toBe(first.body.data.pending_total);
      expect(first.body.data).not.toHaveProperty("items");
      expect(first.body.data).not.toHaveProperty("total");

      // Read-only: a second read returns an identical snapshot.
      const second = await getAge();
      expect(second.body.data).toEqual(first.body.data);
    });
  });

  describe("Dashboard /metrics truth (ADMIN-PLATFORM-TRUTH)", () => {
    const METRICS_USER = "metric-user-000000000000000001";
    const METRICS_RESTAURANT = "a0000000-0000-4000-8000-000000000001";

    function metricsOrder(id: string, status: OrderDTO["status"], total: number, createdIso: string) {
      return {
        id,
        user_id: METRICS_USER,
        restaurant_id: METRICS_RESTAURANT,
        restaurant_name: "Test Cafe",
        items: [],
        total_amount: total,
        status,
        commission_rate: 0.08,
        commission_amount: Math.round(total * 0.08),
        is_catering: false,
        headcount: null,
        pickup_otp: null,
        qr_token: null,
        checked_in: false,
        scheduled_pickup_time: null,
        created_at: createdIso,
        updated_at: createdIso,
      };
    }

    beforeAll(() => {
      sharedOrderRepo._reset();
      sharedPaymentRepo._reset();
      const nowIso = new Date().toISOString();
      const yesterdayIso = new Date(Date.now() - 86400000).toISOString();
      const preWindowIso = new Date(Date.now() - 8 * 86400000).toISOString();
      sharedOrderRepo._seed(metricsOrder("metric-order-0000000000001", "PICKED_UP", 1000, nowIso));
      sharedOrderRepo._seed(metricsOrder("metric-order-0000000000002", "SETTLED", 500, nowIso));
      sharedOrderRepo._seed(metricsOrder("metric-order-0000000000003", "CANCELLED", 9000, nowIso));
      sharedOrderRepo._seed(metricsOrder("metric-order-0000000000004", "REFUNDED", 8000, nowIso));
      sharedOrderRepo._seed(metricsOrder("metric-order-0000000000005", "PICKED_UP", 2000, yesterdayIso));
      sharedOrderRepo._seed(metricsOrder("metric-order-0000000000006", "PICKED_UP", 555, preWindowIso));
      sharedOrderRepo._seed(metricsOrder("metric-order-0000000000007", "CONFIRMED", 120, nowIso));
    });

    it("GET /admin/metrics returns truthful windowed totals and no leakage", async () => {
      const res = await request(app)
        .get("/api/v1/admin/metrics")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.revenue_today).toBe(1500);
      expect(data.fulfilled_orders_today).toBe(2);
      expect(data.active_orders).toBe(1);
      expect(data.daily_series.length).toBe(7);
      expect(data.daily_series[6].revenue).toBe(1500);
      expect(data.daily_series[6].fulfilled_orders).toBe(2);
      const windowTotal = data.daily_series.reduce((sum: number, p: { revenue: number }) => sum + p.revenue, 0);
      // yesterday PICKED_UP 2000 is inside the window; 8-day-old 555 plus
      // CANCELLED 9000 and REFUNDED 8000 never count toward revenue.
      expect(windowTotal).toBe(3500);
      const flat = data.daily_series.flatMap((p: { revenue: number }) => [p.revenue]);
      expect(flat).not.toContain(555);
      expect(flat).not.toContain(9000);
      expect(flat).not.toContain(8000);
      // zero-data bucket is literal 0 (6 days ago)
      expect(data.daily_series[0].revenue).toBe(0);
    });

    it("GET /admin/metrics removes every fabricated KPI field", async () => {
      const res = await request(app)
        .get("/api/v1/admin/metrics")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const data = res.body.data;
      for (const removed of [
        "vendor_churn_pct",
        "webhook_failure_pct",
        "avg_pickup_time_min",
        "cac_amount",
        "ltv_amount",
        "cac_ltv_ratio",
        "daily_revenue",
        "total_orders_today",
      ]) {
        expect(data).not.toHaveProperty(removed);
      }
      expect(data).toHaveProperty("revenue_today");
      expect(data).toHaveProperty("fulfilled_orders_today");
      expect(data).toHaveProperty("active_orders");
      expect(data).toHaveProperty("daily_series");
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
  // Operator suspend/reactivate/demote hierarchy
  // ============================================

  describe("User management hierarchy", () => {
    const seedUser = (id: string, phone: string, role: string) => {
      sharedIdentityRepo._seed({
        id,
        phone,
        role,
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
    };

    beforeEach(async () => {
      sharedIdentityRepo._reset();
      resetRedisForTests();
      seedUser("u-hierarchy-consumer", "+910000000101", "CONSUMER");
      seedUser("u-hierarchy-admin-a", "+910000000102", "ADMIN");
      seedUser("u-hierarchy-admin-b", "+910000000103", "ADMIN");
      seedUser("u-hierarchy-super-a", "+910000000104", "SUPER_ADMIN");
      seedUser("u-hierarchy-super-b", "+910000000105", "SUPER_ADMIN");
      seedUser("admin-test-id", "+919999999999", "CONSUMER");
    });

    it("ADMIN cannot suspend a SUPER_ADMIN", async () => {
      const res = await request(app)
        .put("/api/v1/admin/users/u-hierarchy-super-a/suspend")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(403);
    });

    it("ADMIN cannot suspend another ADMIN", async () => {
      const res = await request(app)
        .put("/api/v1/admin/users/u-hierarchy-admin-a/suspend")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(403);
    });

    it("ADMIN can suspend a CONSUMER", async () => {
      const res = await request(app)
        .put("/api/v1/admin/users/u-hierarchy-consumer/suspend")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
    });

    it("SUPER_ADMIN cannot suspend another SUPER_ADMIN", async () => {
      const res = await request(app)
        .put("/api/v1/admin/users/u-hierarchy-super-b/suspend")
        .set("Authorization", adminToken("SUPER_ADMIN"));
      expect(res.status).toBe(403);
    });

    it("SUPER_ADMIN can suspend an ADMIN", async () => {
      const res = await request(app)
        .put("/api/v1/admin/users/u-hierarchy-admin-a/suspend")
        .set("Authorization", adminToken("SUPER_ADMIN"));
      expect(res.status).toBe(200);
    });

    it("cannot suspend your own account", async () => {
      const res = await request(app)
        .put("/api/v1/admin/users/admin-test-id/suspend")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(403);
    });

    it("ADMIN cannot reactivate an operator account", async () => {
      await request(app)
        .put("/api/v1/admin/users/u-hierarchy-admin-b/suspend")
        .set("Authorization", adminToken("SUPER_ADMIN"));
      const res = await request(app)
        .put("/api/v1/admin/users/u-hierarchy-admin-b/reactivate")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(403);
    });

    it("suspend stores an optional reason and audits it", async () => {
      const res = await request(app)
        .put("/api/v1/admin/users/u-hierarchy-consumer/suspend")
        .set("Authorization", adminToken("ADMIN"))
        .send({ reason: "Abusive behavior" });
      expect(res.status).toBe(200);
      expect(res.body.data.suspended_reason).toBe("Abusive behavior");
    });

    it("cannot demote the last active SUPER_ADMIN", async () => {
      await request(app)
        .put("/api/v1/admin/users/u-hierarchy-super-b/role")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ role: "ADMIN" })
        .expect(200);
      const res = await request(app)
        .put("/api/v1/admin/users/u-hierarchy-super-a/role")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ role: "CONSUMER" });
      expect(res.status).toBe(403);
    });

    it("cannot demote the last active ADMIN", async () => {
      await request(app)
        .put("/api/v1/admin/users/u-hierarchy-admin-b/suspend")
        .set("Authorization", adminToken("SUPER_ADMIN"));
      const res = await request(app)
        .put("/api/v1/admin/users/u-hierarchy-admin-a/role")
        .set("Authorization", adminToken("SUPER_ADMIN"))
        .send({ role: "CONSUMER" });
      expect(res.status).toBe(403);
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
    const ORDER_PREFIX = "admin-override-00000000000";

    function seedOrder(id: string, status: OrderStatus): OrderDTO {
      const now = new Date().toISOString();
      return sharedOrderRepo._seed({
        id,
        user_id: "u-admin-override-0000000001",
        restaurant_id: "r-admin-override-0000000001",
        restaurant_name: "Override Cafe",
        items: [],
        total_amount: 100,
        status,
        commission_rate: 0.1,
        commission_amount: 10,
        is_catering: false,
        headcount: null,
        pickup_otp: null,
        qr_token: null,
        checked_in: false,
        scheduled_pickup_time: null,
        created_at: now,
        updated_at: now,
      });
    }

    function override(orderId: string, role: string, payload: Record<string, unknown>) {
      return request(app)
        .post(`/api/v1/admin/orders/${orderId}/override-status`)
        .set("Authorization", adminToken(role))
        .send(payload);
    }

    beforeEach(() => {
      sharedOrderRepo._reset();
      sharedAuditRepo._reset();
    });

    it("GET /admin/orders/:id returns 404 for unknown order", async () => {
      const res = await request(app)
        .get("/api/v1/admin/orders/nonexistent-order-id")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(404);
    });

    it("POST /admin/orders/:id/override-status blocked for ADMIN (not SUPER_ADMIN)", async () => {
      const o = seedOrder(`${ORDER_PREFIX}1`, "CONFIRMED");
      const res = await override(o.id, "ADMIN", { status: "PREPARING", from_status: "CONFIRMED" });
      expect(res.status).toBe(403);
    });

    it("POST /admin/orders/:id/override-status blocked for OPS_AGENT", async () => {
      const o = seedOrder(`${ORDER_PREFIX}2`, "CONFIRMED");
      const res = await override(o.id, "OPS_AGENT", { status: "PREPARING", from_status: "CONFIRMED" });
      expect(res.status).toBe(403);
    });

    it("POST /admin/orders/:id/override-status returns 404 for unknown order (SUPER_ADMIN)", async () => {
      const res = await override("nonexistent-order-id", "SUPER_ADMIN", {
        status: "CANCELLED",
        from_status: "CONFIRMED",
      });
      expect(res.status).toBe(404);
    });

    it("POST /admin/orders/:id/override-status returns 400 for invalid status", async () => {
      const o = seedOrder(`${ORDER_PREFIX}3`, "CONFIRMED");
      const res = await override(o.id, "SUPER_ADMIN", { status: "INVALID", from_status: "CONFIRMED" });
      expect(res.status).toBe(400);
    });

    // U1 — normal CAS success CONFIRMED -> PREPARING
    it("U1 default CAS transition succeeds (CONFIRMED -> PREPARING)", async () => {
      const o = seedOrder(`${ORDER_PREFIX}4`, "CONFIRMED");
      const res = await override(o.id, "SUPER_ADMIN", { status: "PREPARING", from_status: "CONFIRMED" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("PREPARING");
      expect((await sharedOrderRepo.getById(o.id))!.status).toBe("PREPARING");
    });

    // U2 — stale from_status -> 409, no overwrite
    it("U2 stale from_status is rejected with 409 and no overwrite", async () => {
      const o = seedOrder(`${ORDER_PREFIX}5`, "CONFIRMED");
      const res = await override(o.id, "SUPER_ADMIN", { status: "ALMOST_READY", from_status: "PREPARING" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONCURRENT_MODIFICATION");
      expect((await sharedOrderRepo.getById(o.id))!.status).toBe("CONFIRMED");
    });

    // U3 — simulated concurrent fulfillment wins: CAS null -> 409, no blind fallback
    it("U3 lost CAS race returns 409 without any blind fallback write", async () => {
      const o = seedOrder(`${ORDER_PREFIX}6`, "CONFIRMED");
      const repoHack = sharedOrderRepo as unknown as Record<string, unknown>;
      const realTransition = sharedOrderRepo.transitionStatus;
      const realUpdate = sharedOrderRepo.updateStatus;
      const casMock = vi.fn().mockResolvedValue(null);
      const blindMock = vi.fn().mockResolvedValue(null);
      repoHack.transitionStatus = casMock;
      repoHack.updateStatus = blindMock;
      try {
        const res = await override(o.id, "SUPER_ADMIN", { status: "PREPARING", from_status: "CONFIRMED" });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("CONCURRENT_MODIFICATION");
        expect(casMock).toHaveBeenCalledTimes(1);
        expect(blindMock).not.toHaveBeenCalled();
      } finally {
        repoHack.transitionStatus = realTransition;
        repoHack.updateStatus = realUpdate;
      }
      expect((await sharedOrderRepo.getById(o.id))!.status).toBe("CONFIRMED");
    });

    // U4 — terminal regression rejected (force) and default regression rejected
    it("U4 terminal regression is rejected even with force", async () => {
      const o = seedOrder(`${ORDER_PREFIX}7`, "PICKED_UP");
      const res = await override(o.id, "SUPER_ADMIN", {
        status: "CONFIRMED",
        from_status: "PICKED_UP",
        force: true,
        reason: "customer complaint",
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
      expect((await sharedOrderRepo.getById(o.id))!.status).toBe("PICKED_UP");
    });

    it("U4b regressive default transition is rejected without force", async () => {
      const o = seedOrder(`${ORDER_PREFIX}8`, "ALMOST_READY");
      const res = await override(o.id, "SUPER_ADMIN", { status: "PREPARING", from_status: "ALMOST_READY" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
      expect((await sharedOrderRepo.getById(o.id))!.status).toBe("ALMOST_READY");
    });

    // U5 — allowed force + reason succeeds
    it("U5 explicit force with reason permits an out-of-machine transition", async () => {
      const o = seedOrder(`${ORDER_PREFIX}9`, "CONFIRMED");
      const res = await override(o.id, "SUPER_ADMIN", {
        status: "READY_FOR_PICKUP",
        from_status: "CONFIRMED",
        force: true,
        reason: "kitchen expedite",
      });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("READY_FOR_PICKUP");
      expect((await sharedOrderRepo.getById(o.id))!.status).toBe("READY_FOR_PICKUP");
    });

    // U6 — force without reason -> 400
    it("U6 force without a reason is rejected with 400", async () => {
      const o = seedOrder(`${ORDER_PREFIX}a`, "CONFIRMED");
      const res = await override(o.id, "SUPER_ADMIN", {
        status: "READY_FOR_PICKUP",
        from_status: "CONFIRMED",
        force: true,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect((await sharedOrderRepo.getById(o.id))!.status).toBe("CONFIRMED");
    });

    // U7 — SETTLED/payment-coupled source/target blocked even with force
    it("U7 payment-coupled target SETTLED is rejected even with force", async () => {
      const o = seedOrder(`${ORDER_PREFIX}b`, "CONFIRMED");
      const res = await override(o.id, "SUPER_ADMIN", {
        status: "SETTLED",
        from_status: "CONFIRMED",
        force: true,
        reason: "settle early",
      });
      expect(res.status).toBe(400);
      expect((await sharedOrderRepo.getById(o.id))!.status).toBe("CONFIRMED");
    });

    it("U7b payment-coupled source is rejected even with force", async () => {
      const o = seedOrder(`${ORDER_PREFIX}c`, "PAYMENT_PENDING");
      const res = await override(o.id, "SUPER_ADMIN", {
        status: "CONFIRMED",
        from_status: "PAYMENT_PENDING",
        force: true,
        reason: "skip payment",
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
      expect((await sharedOrderRepo.getById(o.id))!.status).toBe("PAYMENT_PENDING");
    });

    // U8 — audit on success includes fields; CAS miss writes no success audit
    it("U8 success audit records previous/new/from/force/reason", async () => {
      const o = seedOrder(`${ORDER_PREFIX}d`, "CONFIRMED");
      const res = await override(o.id, "SUPER_ADMIN", {
        status: "ALMOST_READY",
        from_status: "CONFIRMED",
        force: true,
        reason: "manual push",
      });
      expect(res.status).toBe(200);
      const entry = (await sharedAuditRepo.all()).find((e) => e.action === "order_status_overridden");
      expect(entry).toBeTruthy();
      expect(entry!.actor_id).toBe("admin-test-id");
      expect(entry!.metadata).toMatchObject({
        order_id: o.id,
        previous_status: "CONFIRMED",
        from_status: "CONFIRMED",
        new_status: "ALMOST_READY",
        force: true,
        reason: "manual push",
      });
    });

    it("U8b CAS miss writes no success override audit", async () => {
      const o = seedOrder(`${ORDER_PREFIX}e`, "CONFIRMED");
      const before = (await sharedAuditRepo.all()).length;
      const res = await override(o.id, "SUPER_ADMIN", {
        status: "PREPARING",
        from_status: "ALMOST_READY",
      });
      expect(res.status).toBe(409);
      const after = (await sharedAuditRepo.all()).length;
      expect(after).toBe(before);
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
        items: [{ id: "od-item-000000000000001", menu_item_id: "m1", name: "Burger", base_price: 100, quantity: 2, customizations: [], customization_total: 0, item_subtotal: 200, gift_id: null }],
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

  // ============================================
  // COMMISSION-SNAPSHOT-MIGRATION-A3: U7
  // Admin commission must equal settlement commission for the same order,
  // both sourced from the persisted snapshot (a non-canonical value proves
  // neither recomputes).
  // ============================================

  describe("Commission truth (COMMISSION-SNAPSHOT-MIGRATION-A3)", () => {
    const ORDER_ID = "cs-a3-0000000000000000001";
    const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";

    beforeAll(async () => {
      sharedOrderRepo._reset();
      const created = new Date().toISOString();
      sharedOrderRepo._seed({
        id: ORDER_ID,
        user_id: "cs-a3-user-000000000001",
        restaurant_id: RESTAURANT_ID,
        restaurant_name: "Test Cafe",
        items: [],
        total_amount: 500,
        status: "SETTLED",
        // Deliberately non-canonical snapshot: canonical would be 0.08 / 40.
        commission_rate: 0.05,
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
    });

    it("U7: admin revenue + vendor metrics commission equal settlement commission", async () => {
      const revenueRes = await request(app)
        .get("/api/v1/admin/revenue")
        .set("Authorization", adminToken("ADMIN"));
      expect(revenueRes.status).toBe(200);

      const vendorRes = await request(app)
        .get("/api/v1/admin/vendors/metrics")
        .set("Authorization", adminToken("ADMIN"));
      expect(vendorRes.status).toBe(200);

      const seeded = (await sharedOrderRepo.getById(ORDER_ID))!;
      const settlementCommission = computeSettlementLine(seeded).commission_amount;
      const vendorRow = (vendorRes.body.data as { id: string; commission: number }[]).find(
        (r) => r.id === RESTAURANT_ID,
      );

      expect(settlementCommission).toBe(20);
      expect(revenueRes.body.data.totals.commission).toBe(20);
      expect(vendorRow?.commission).toBe(20);
    });
  });

  // ============================================
  // RESTAURANT-COMMISSION-UI-TRUTH-A2
  // `restaurants.commission_rate` is non-authoritative internal config and
  // must not be exposed through admin read surfaces. Money stays authoritative
  // from the order snapshot (proved by the suites above).
  // ============================================

  describe("Commission config read-surface truth (RESTAURANT-COMMISSION-UI-TRUTH-A2)", () => {
    const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";

    beforeEach(() => {
      sharedVendorApplicationRepo._reset();
      sharedOrderRepo._reset();
    });

    // A1 — admin vendors
    it("A1 GET /admin/vendors omits commission_rate and preserves other fields", async () => {
      const res = await request(app)
        .get("/api/v1/admin/vendors")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const rows = res.body.data as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r).not.toHaveProperty("commission_rate");
        expect(r).toHaveProperty("id");
        expect(r).toHaveProperty("name");
        expect(r).toHaveProperty("is_active");
      }
    });

    // A2 — admin order detail
    it("A2 GET /admin/orders/:id keeps restaurant identity but omits commission_rate", async () => {
      sharedOrderRepo._seed({
        id: "rcu-a2-000000000000000001",
        user_id: "rcu-a2-user-000000000001",
        restaurant_id: RESTAURANT_ID,
        restaurant_name: "Test Cafe",
        items: [],
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
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const res = await request(app)
        .get("/api/v1/admin/orders/rcu-a2-000000000000000001")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const d = res.body.data as { restaurant: Record<string, unknown>; commission_amount: number };
      expect(d.restaurant).toBeTruthy();
      expect(d.restaurant.id).toBe(RESTAURANT_ID);
      expect(d.restaurant.name).toBe("Biryani House");
      expect(d.restaurant).not.toHaveProperty("commission_rate");
      expect(d.commission_amount).toBe(20);
    });

    // A3 — admin vendor metrics
    it("A3 GET /admin/vendors/metrics omits commission_rate but keeps authoritative totals", async () => {
      sharedOrderRepo._seed({
        id: "rcu-a3-000000000000000001",
        user_id: "rcu-a3-user-000000000001",
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
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const res = await request(app)
        .get("/api/v1/admin/vendors/metrics")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const rows = res.body.data as Record<string, unknown>[];
      for (const r of rows) {
        expect(r).not.toHaveProperty("commission_rate");
      }
      const vendor = rows.find((r) => r.id === RESTAURANT_ID);
      expect(vendor).toBeTruthy();
      expect(vendor!.revenue).toBe(400);
      expect(vendor!.commission).toBe(40);
    });

    // A4 — admin vendor applications
    it("A4 GET /admin/vendor-applications omits commission_rate and preserves application data", async () => {
      const created = await sharedVendorApplicationRepo.create({
        applicant_id: "rcu-a4-user-000000000001",
        name: "RCU A4 Kitchen",
        gst_number: "29ABCDE1234F1Z5",
        fssai_license: "12345678901234",
        phone: "+919999000001",
      });
      const res = await request(app)
        .get("/api/v1/admin/vendor-applications")
        .set("Authorization", adminToken("ADMIN"));
      expect(res.status).toBe(200);
      const rows = res.body.data as Record<string, unknown>[];
      const application = rows.find((a) => a.id === created.id);
      expect(application).toBeTruthy();
      expect(application).not.toHaveProperty("commission_rate");
      expect(application!.name).toBe("RCU A4 Kitchen");
      expect(application!.status).toBe("PENDING");
      expect(application!.gst_number).toBe("29ABCDE1234F1Z5");
    });
  });
});
