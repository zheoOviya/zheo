import { beforeEach, describe, expect, it } from "vitest";
import { assertRestaurantAccess } from "./vendorAccess";
import { getCatalogRepository } from "../routes/catalog";
import { sharedChainRepo, sharedUserRoleRepo } from "../repositories/shared";
import { makeChain } from "../repositories/chainRepository";

// ============================================
// Vendor restaurant ownership guard (scoped RBAC)
// ============================================

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const STAFF = "00000000-0000-4000-8000-0000000000a2";
const OUTSIDER = "00000000-0000-4000-8000-0000000000a3";

function locals(userId: string, role = "VENDOR_OWNER") {
  return { locals: { userId, userRole: role } };
}

async function createOwnedRestaurant(): Promise<{ id: string }> {
  return getCatalogRepository().createRestaurant({
    name: "Test Kitchen",
    gst_number: null,
    fssai_license: null,
    owner_id: OWNER,
    commission_rate: 0.08,
    lat: null,
    lng: null,
    pickup_eta_min: 20,
  });
}

describe("assertRestaurantAccess", () => {
  beforeEach(() => {
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
  });

  it("allows ADMIN to bypass ownership checks", async () => {
    await expect(
      assertRestaurantAccess(locals(OUTSIDER, "ADMIN"), "any-restaurant"),
    ).resolves.toBeUndefined();
  });

  it("allows the restaurant owner via legacy owner_id", async () => {
    const r = await createOwnedRestaurant();
    await expect(assertRestaurantAccess(locals(OWNER), r.id)).resolves.toBeUndefined();
  });

  it("allows a scoped staff member who is not the owner", async () => {
    const r = await createOwnedRestaurant();
    await sharedUserRoleRepo.assign({
      user_id: STAFF,
      scope_type: "restaurant",
      scope_id: r.id,
      role: "VENDOR_STAFF",
    });
    await expect(
      assertRestaurantAccess(locals(STAFF, "VENDOR_STAFF"), r.id),
    ).resolves.toBeUndefined();
  });

  it("allows a chain-scope member across outlets", async () => {
    const r = await createOwnedRestaurant();
    const chain = makeChain("Spice Chain", OWNER);
    sharedChainRepo._seed(chain, [r.id]);
    await sharedUserRoleRepo.assign({
      user_id: STAFF,
      scope_type: "chain",
      scope_id: chain.id,
      role: "VENDOR_OWNER",
    });
    await expect(
      assertRestaurantAccess(locals(STAFF, "VENDOR_OWNER"), r.id),
    ).resolves.toBeUndefined();
  });

  it("rejects an outsider with 403", async () => {
    const r = await createOwnedRestaurant();
    await expect(assertRestaurantAccess(locals(OUTSIDER), r.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects when the restaurant does not exist with 404", async () => {
    await expect(
      assertRestaurantAccess(locals(OWNER), "missing-restaurant"),
    ).rejects.toMatchObject({ status: 404 });
  });
});
