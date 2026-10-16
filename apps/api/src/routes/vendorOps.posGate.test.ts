import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { seedAuthIdentity } from "../test/support/authIdentity";
import { getCatalogRepository, resetCatalogRepository } from "./catalog";
import { sharedIdentityRepo, sharedOrderRepo } from "../repositories/shared";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";

// ============================================
// POS-MOCK-PROD-ISOLATION (route boundary)
//
// Simulates the production composition: `createMenuSyncService` returns null
// (no POS provider wired - see services/menuSync.ts), so the vendor POS routes
// must fail closed with 503 BEFORE any catalog mutation, outbox enqueue or
// order creation. The mock client is never invoked.
// ============================================

vi.mock("../services/menuSync", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/menuSync")>();
  return {
    ...actual,
    // Production has no provider: no service, hence no mock client.
    createMenuSyncService: () => null,
  };
});

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner

function vendorAuthHeaders() {
  seedAuthIdentity({
    sub: OWNER_ID,
    phone: "+919876543210",
    role: "VENDOR_OWNER",
  });
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: OWNER_ID,
      phone: "+919876543210",
      role: "VENDOR_OWNER",
      device_fingerprint: "fp_posgate_vendor",
    })}`,
  };
}

const posItemsOf = async (restaurantId: string) =>
  (await getCatalogRepository().getMenuAll(restaurantId)).filter((item) =>
    (item.pos_item_id ?? "").startsWith("pp-"),
  );

describe("POS-MOCK-PROD-ISOLATION route fail-closed", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    memoryEventOutbox._reset();
    sharedOrderRepo._reset();
    sharedIdentityRepo._reset();
    app = createApp();
  });

  it("PROD_SYNC_MENU_RETURNS_503 with zero catalog mutation and zero outbox enqueue", async () => {
    const outboxBefore = memoryEventOutbox._all().length;
    const menuBefore = (await getCatalogRepository().getMenuAll(REST_ID)).length;

    const res = await request(app)
      .post(`/api/vendor/pos/sync-menu?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(503);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("POS_PROVIDER_UNCONFIGURED");
    expect(res.body.error.message).toBe("POS menu integration is not configured");

    expect(await posItemsOf(REST_ID)).toHaveLength(0);
    expect((await getCatalogRepository().getMenuAll(REST_ID)).length).toBe(menuBefore);
    expect(memoryEventOutbox._all().length).toBe(outboxBefore);
    expect(
      memoryEventOutbox._all().filter((row) => row.event_name === "PosMenuSynced"),
    ).toHaveLength(0);
  });

  it("PROD_SIMULATE_ORDER_RETURNS_503 before menu or order mutation", async () => {
    const outboxBefore = memoryEventOutbox._all().length;

    const res = await request(app)
      .post(`/api/vendor/pos/simulate-order?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(503);

    expect(res.body.error.code).toBe("POS_PROVIDER_UNCONFIGURED");

    expect(await posItemsOf(REST_ID)).toHaveLength(0);
    expect(await sharedOrderRepo.getByRestaurant(REST_ID)).toHaveLength(0);
    expect(memoryEventOutbox._all().length).toBe(outboxBefore);
  });
});
