import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { jwtService } from "../services/jwt";
import {
  sharedAuditRepo,
  sharedIdentityRepo,
  sharedVendorApplicationRepo,
  sharedUserRoleRepo,
  sharedChainRepo,
} from "../repositories/shared";
import { resetCatalogRepository, getCatalogRepository } from "./catalog";
import { resetRedisForTests } from "../lib/redis";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";

function tokenFor(sub: string, role: string) {
  return `Bearer ${jwtService.signAccessToken({
    sub,
    phone: "+9100000000",
    role,
    device_fingerprint: "fp_test_vendor_app",
  })}`;
}

const APPLICANT_ID = "vapp-applicant-0000000000001";
const ADMIN_ACTOR_ID = "vapp-admin-0000000000001";
const SUPER_ADMIN_ACTOR_ID = "vapp-superadmin-000000001";

describe("Vendor onboarding applications", () => {
  let app: Express;

  /** Durable outbox rows enqueued for an aggregate, filtered in-memory. */
  const outboxFor = (eventName: string, appId: string) =>
    memoryEventOutbox
      ._all()
      .filter((r) => r.event_name === eventName && r.aggregate_id === appId);

  beforeAll(async () => {
    app = createApp();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    memoryEventOutbox._reset();
    sharedVendorApplicationRepo._reset();
    sharedIdentityRepo._reset();
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
    sharedAuditRepo._reset();
    resetCatalogRepository();
    resetRedisForTests();
    sharedIdentityRepo._seed({
      id: APPLICANT_ID,
      phone: "+9100000001",
      role: "CONSUMER",
      is_suspended: false,
      totp_enabled: false,
      created_at: new Date().toISOString(),
    });
  });

  function apply(overrides: Record<string, unknown> = {}) {
    return request(app)
      .post("/api/v1/vendor-applications")
      .set("Authorization", tokenFor(APPLICANT_ID, "CONSUMER"))
      .send({
        name: "Spice Route",
        gst_number: "27ABCDE1234F1Z5",
        fssai_license: "11522000000000",
        phone: "+9100000001",
        city: "Mumbai",
        address: "12 Linking Road, Bandra",
        ...overrides,
      });
  }

  it("rejects unauthenticated applications with 401", async () => {
    const res = await request(app)
      .post("/api/v1/vendor-applications")
      .send({ name: "X", gst_number: "12345", fssai_license: "67890", phone: "+9100000001" });
    expect(res.status).toBe(401);
  });

  it("validates the application payload", async () => {
    const res = await apply({ name: "X", gst_number: "short" });
    expect(res.status).toBe(400);
  });

  it("creates a PENDING application", async () => {
    const res = await apply();
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("PENDING");
    expect(res.body.data.applicant_id).toBe(APPLICANT_ID);
    expect(res.body.data.type).toBe("SINGLE");
    expect(res.body.data.outlet_count).toBe(1);
  });

  it("defaults omitted type to SINGLE and outlet_count to 1", async () => {
    const res = await apply();
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe("SINGLE");
    expect(res.body.data.outlet_count).toBe(1);
  });

  it("stores CHAIN type with outlet_count", async () => {
    const res = await apply({ type: "CHAIN", outlet_count: 4 });
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe("CHAIN");
    expect(res.body.data.outlet_count).toBe(4);
  });

  it("clamps outlet_count to 1 for SINGLE applications", async () => {
    const res = await apply({ type: "SINGLE", outlet_count: 9 });
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe("SINGLE");
    expect(res.body.data.outlet_count).toBe(1);
  });

  it("lists the applicant's own applications", async () => {
    await apply();
    const res = await request(app)
      .get("/api/v1/vendor-applications/mine")
      .set("Authorization", tokenFor(APPLICANT_ID, "CONSUMER"));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].name).toBe("Spice Route");
  });

  it("admin can list all applications", async () => {
    await apply();
    const res = await request(app)
      .get("/api/v1/admin/vendor-applications")
      .set("Authorization", tokenFor(ADMIN_ACTOR_ID, "ADMIN"));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  it("admin can read application metrics with counts and trend", async () => {
    await apply();
    const res = await request(app)
      .get("/api/v1/admin/vendor-applications/metrics")
      .set("Authorization", tokenFor(ADMIN_ACTOR_ID, "ADMIN"));
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.pending).toBe(1);
    expect(res.body.data.approved).toBe(0);
    expect(res.body.data.rejected).toBe(0);
    expect(res.body.data.trend).toHaveLength(14);
    expect(res.body.data.trend[13].submitted).toBe(1);
  });

  it("super admin approves an application: creates restaurant + upgrades role", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;

    const res = await request(app)
      .put(`/api/v1/admin/vendor-applications/${appId}/approve`)
      .set("Authorization", tokenFor(SUPER_ADMIN_ACTOR_ID, "SUPER_ADMIN"));
    expect(res.status).toBe(200);
    expect(res.body.data.application.status).toBe("APPROVED");
    expect(res.body.data.restaurant.name).toBe("Spice Route");
    expect(res.body.data.restaurant.is_active).toBe(true);
    expect(res.body.data.restaurant.owner_id).toBe(APPLICANT_ID);

    const owner = await sharedIdentityRepo.getById(APPLICANT_ID);
    expect(owner?.role).toBe("VENDOR_OWNER");

    const scoped = await sharedUserRoleRepo.findByUser(APPLICANT_ID);
    expect(
      scoped.some((r) => r.scope_type === "restaurant" && r.role === "VENDOR_OWNER"),
    ).toBe(true);
  });

  it("CHAIN approval creates a chain + N restaurants with chain-scoped role", async () => {
    const created = await apply({ type: "CHAIN", outlet_count: 3 });
    const appId = created.body.data.id as string;

    const res = await request(app)
      .put(`/api/v1/admin/vendor-applications/${appId}/approve`)
      .set("Authorization", tokenFor(SUPER_ADMIN_ACTOR_ID, "SUPER_ADMIN"));
    expect(res.status).toBe(200);
    expect(res.body.data.application.status).toBe("APPROVED");
    expect(res.body.data.chain_id).toBeTruthy();
    expect(res.body.data.outlet_ids).toHaveLength(3);

    const chainId = res.body.data.chain_id as string;
    const chain = await sharedChainRepo.getById(chainId);
    expect(chain?.name).toBe("Spice Route");
    expect(chain?.owner_id).toBe(APPLICANT_ID);

    const repo = getCatalogRepository();
    const restaurants = (await repo.getAllRestaurants()).filter(
      (r) => r.chain_id === chainId,
    );
    expect(restaurants).toHaveLength(3);
    const names = restaurants.map((r) => r.name).sort();
    expect(names).toEqual([
      "Spice Route — Outlet 1",
      "Spice Route — Outlet 2",
      "Spice Route — Outlet 3",
    ]);
    for (const r of restaurants) {
      expect(r.chain_id).toBe(chainId);
      expect(r.owner_id).toBe(APPLICANT_ID);
    }

    const owner = await sharedIdentityRepo.getById(APPLICANT_ID);
    expect(owner?.role).toBe("VENDOR_OWNER");

    const scoped = await sharedUserRoleRepo.findByUser(APPLICANT_ID);
    expect(
      scoped.some((r) => r.scope_type === "chain" && r.scope_id === chainId && r.role === "VENDOR_OWNER"),
    ).toBe(true);
  });

  it("SINGLE approval keeps restaurant-scoped role and no chain", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;

    const res = await request(app)
      .put(`/api/v1/admin/vendor-applications/${appId}/approve`)
      .set("Authorization", tokenFor(SUPER_ADMIN_ACTOR_ID, "SUPER_ADMIN"));
    expect(res.status).toBe(200);
    expect(res.body.data.chain_id).toBeNull();
    expect(res.body.data.outlet_ids).toHaveLength(0);
    expect(res.body.data.restaurant.chain_id).toBeNull();
    expect(res.body.data.restaurant.name).toBe("Spice Route");
    expect(res.body.data.restaurant.owner_id).toBe(APPLICANT_ID);

    const scoped = await sharedUserRoleRepo.findByUser(APPLICANT_ID);
    expect(
      scoped.some((r) => r.scope_type === "restaurant" && r.role === "VENDOR_OWNER"),
    ).toBe(true);
    expect(scoped.some((r) => r.scope_type === "chain")).toBe(false);
  });

  it("approving a non-pending application conflicts", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    await request(app)
      .put(`/api/v1/admin/vendor-applications/${appId}/approve`)
      .set("Authorization", tokenFor(SUPER_ADMIN_ACTOR_ID, "SUPER_ADMIN"))
      .expect(200);
    const res = await request(app)
      .put(`/api/v1/admin/vendor-applications/${appId}/approve`)
      .set("Authorization", tokenFor(SUPER_ADMIN_ACTOR_ID, "SUPER_ADMIN"));
    expect(res.status).toBe(409);
  });

  it("super admin rejects an application with a reason", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;

    const res = await request(app)
      .put(`/api/v1/admin/vendor-applications/${appId}/reject`)
      .set("Authorization", tokenFor(SUPER_ADMIN_ACTOR_ID, "SUPER_ADMIN"))
      .send({ reason: "GST number could not be verified" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("REJECTED");
    expect(res.body.data.rejection_reason).toBe("GST number could not be verified");
  });

  it("OPS_AGENT cannot approve applications", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;

    const res = await request(app)
      .put(`/api/v1/admin/vendor-applications/${appId}/approve`)
      .set("Authorization", tokenFor(ADMIN_ACTOR_ID, "OPS_AGENT"));
    expect(res.status).toBe(403);
  });

  it("ADMIN cannot approve applications (SUPER_ADMIN only)", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;

    const res = await request(app)
      .put(`/api/v1/admin/vendor-applications/${appId}/approve`)
      .set("Authorization", tokenFor(ADMIN_ACTOR_ID, "ADMIN"));
    expect(res.status).toBe(403);
  });

  function approveApp(id: string) {
    return request(app)
      .put(`/api/v1/admin/vendor-applications/${id}/approve`)
      .set("Authorization", tokenFor(SUPER_ADMIN_ACTOR_ID, "SUPER_ADMIN"));
  }

  function rejectApp(id: string, reason?: string) {
    const req = request(app)
      .put(`/api/v1/admin/vendor-applications/${id}/reject`)
      .set("Authorization", tokenFor(SUPER_ADMIN_ACTOR_ID, "SUPER_ADMIN"));
    return reason === undefined ? req.send({}) : req.send({ reason });
  }

  // ============================================
  // A2 atomic approve/reject control flow (memory mode)
  // ============================================

  it("A1: sequential second approve conflicts 409", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    await approveApp(appId).expect(200);
    const res = await approveApp(appId);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("already approved");
  });

  it("A2: approve after rejected conflicts 409", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    await rejectApp(appId, "bad docs").expect(200);
    const res = await approveApp(appId);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("already rejected");
  });

  it("A3: approving a missing application returns 404", async () => {
    const res = await approveApp("00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });

  it("A4: SINGLE approve creates exactly one restaurant", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    const res = await approveApp(appId);
    expect(res.status).toBe(200);
    expect(res.body.data.application.status).toBe("APPROVED");
    expect(res.body.data.chain_id).toBeNull();
    expect(res.body.data.outlet_ids).toHaveLength(0);
    expect(res.body.data.restaurant.owner_id).toBe(APPLICANT_ID);
    expect(res.body.data.restaurant.name).toBe("Spice Route");
  });

  it("A5: CHAIN approve creates one chain + exact outlet_count restaurants", async () => {
    const created = await apply({ type: "CHAIN", outlet_count: 3 });
    const appId = created.body.data.id as string;
    const res = await approveApp(appId);
    expect(res.status).toBe(200);
    const chainId = res.body.data.chain_id as string;
    expect(chainId).toBeTruthy();
    expect(res.body.data.outlet_ids).toHaveLength(3);
    const chain = await sharedChainRepo.getById(chainId);
    expect(chain?.owner_id).toBe(APPLICANT_ID);
    const restaurants = (await getCatalogRepository().getAllRestaurants()).filter(
      (r) => r.chain_id === chainId,
    );
    expect(restaurants).toHaveLength(3);
  });

  it("A6: approve upgrades role, assigns scoped role and audits", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    const res = await approveApp(appId);
    expect(res.status).toBe(200);
    const owner = await sharedIdentityRepo.getById(APPLICANT_ID);
    expect(owner?.role).toBe("VENDOR_OWNER");
    const scoped = await sharedUserRoleRepo.findByUser(APPLICANT_ID);
    expect(
      scoped.some((r) => r.scope_type === "restaurant" && r.role === "VENDOR_OWNER"),
    ).toBe(true);
    const logs = await sharedAuditRepo.findByActor(SUPER_ADMIN_ACTOR_ID);
    expect(
      logs.some(
        (l) => l.action === "vendor_application_approved" && l.metadata.application_id === appId,
      ),
    ).toBe(true);
  });

  it("A7: approval persists exactly one durable event for the committed transition", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    const res = await approveApp(appId);
    expect(res.status).toBe(200);
    const rows = outboxFor("VendorApplicationApproved", appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("PENDING");
    expect((await sharedVendorApplicationRepo.getById(appId))?.status).toBe("APPROVED");
  });

  it("A8: CAS-null loser produces zero side effects", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    await approveApp(appId).expect(200);

    const spy = vi.spyOn(getCatalogRepository(), "createRestaurant");
    const res = await approveApp(appId);
    expect(res.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    expect(outboxFor("VendorApplicationApproved", appId)).toHaveLength(1);
  });

  // ============================================
  // A2 atomic reject control flow (memory mode)
  // ============================================

  it("J1: PENDING -> REJECTED succeeds with reason", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    const res = await rejectApp(appId, "GST mismatch");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("REJECTED");
    expect(res.body.data.rejection_reason).toBe("GST mismatch");
  });

  it("J2: second reject conflicts 409", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    await rejectApp(appId, "bad").expect(200);
    const res = await rejectApp(appId, "bad");
    expect(res.status).toBe(409);
  });

  it("J3: reject after approved conflicts 409", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    await approveApp(appId).expect(200);
    const res = await rejectApp(appId, "bad");
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("already approved");
  });

  it("J4: rejecting a missing application returns 404", async () => {
    const res = await rejectApp("00000000-0000-4000-8000-000000000000", "bad");
    expect(res.status).toBe(404);
  });

  it("J5: rejection audit is written only after a successful CAS", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    await rejectApp(appId, "bad").expect(200);
    const logs = await sharedAuditRepo.findByActor(SUPER_ADMIN_ACTOR_ID);
    expect(
      logs.some(
        (l) => l.action === "vendor_application_rejected" && l.metadata.application_id === appId,
      ),
    ).toBe(true);
  });

  it("J6: loser reject writes no additional audit and enqueues no extra event", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    await rejectApp(appId, "bad").expect(200);
    const res = await rejectApp(appId, "bad");
    expect(res.status).toBe(409);
    const logs = await sharedAuditRepo.findByActor(SUPER_ADMIN_ACTOR_ID);
    expect(
      logs.filter(
        (l) => l.action === "vendor_application_rejected" && l.metadata.application_id === appId,
      ),
    ).toHaveLength(1);
    expect(outboxFor("VendorApplicationRejected", appId)).toHaveLength(1);
  });

  // ============================================
  // A2 failure control flow (memory mode — no rollback claim)
  // ============================================

  it("F1/F2: transaction callback error propagates and enqueues nothing", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    vi.spyOn(getCatalogRepository(), "createRestaurant").mockRejectedValueOnce(
      new Error("catalog boom"),
    );
    const res = await approveApp(appId);
    expect(res.status).toBe(500);
    expect(outboxFor("VendorApplicationApproved", appId)).toHaveLength(0);
  });

  it("F3: committed approval is durable exactly once (no direct+outbox double path)", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    const res = await approveApp(appId);
    expect(res.status).toBe(200);
    expect(outboxFor("VendorApplicationApproved", appId)).toHaveLength(1);
  });

  // ============================================
  // EVT-B2A producer wiring — named invariants
  // ============================================

  it("B2A-A1: approval commit persists exactly one VendorApplicationApproved row", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    const res = await approveApp(appId);
    expect(res.status).toBe(200);
    const rows = outboxFor("VendorApplicationApproved", appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(appId);
    expect(rows[0]?.status).toBe("PENDING");
    expect((rows[0]?.payload as { applicant_id?: string }).applicant_id).toBe(APPLICANT_ID);
  });

  it("B2A-A2: rejection commit persists exactly one VendorApplicationRejected row", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    const res = await rejectApp(appId, "GST mismatch");
    expect(res.status).toBe(200);
    const rows = outboxFor("VendorApplicationRejected", appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(appId);
    expect(rows[0]?.status).toBe("PENDING");
  });

  it("B2A-A3: aborted transition enqueues zero events (memory has no rollback)", async () => {
    const created = await apply();
    const appId = created.body.data.id as string;
    vi.spyOn(getCatalogRepository(), "createRestaurant").mockRejectedValueOnce(
      new Error("catalog boom"),
    );
    const res = await approveApp(appId);
    expect(res.status).toBe(500);
    // The enqueue is the LAST step, so a failure before it leaves no event row.
    // Business rollback atomicity is Postgres-only (realPgProducerOutboxBoundary).
    expect(outboxFor("VendorApplicationApproved", appId)).toHaveLength(0);
  });
});
