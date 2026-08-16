import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { jwtService } from "../services/jwt";
import {
  sharedIdentityRepo,
  sharedVendorApplicationRepo,
  sharedUserRoleRepo,
  sharedChainRepo,
} from "../repositories/shared";
import { resetCatalogRepository, getCatalogRepository } from "./catalog";
import { resetRedisForTests } from "../lib/redis";

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

  beforeAll(async () => {
    app = createApp();
  });

  beforeEach(async () => {
    sharedVendorApplicationRepo._reset();
    sharedIdentityRepo._reset();
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
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
});
