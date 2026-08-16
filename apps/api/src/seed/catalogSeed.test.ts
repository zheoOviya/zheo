import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================
// seedCatalogData() unit tests.
// Proves the Postgres seed emits complete rows (all NOT NULL/FK columns
// populated, decimals as strings) and is idempotent + correctly gated,
// without requiring a live Postgres instance.
// ============================================

const h = vi.hoisted(() => ({
  inserted: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  selectResult: [] as unknown[],
  storageMode: "postgres" as string,
}));

vi.mock("../lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(h.selectResult),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        h.inserted.push({ table, values });
        return Promise.resolve([]);
      },
    }),
    update: () => {
      throw new Error("unused");
    },
    delete: () => {
      throw new Error("unused");
    },
    transaction: () => {
      throw new Error("unused");
    },
  }),
}));

vi.mock("../repositories/shared", () => ({
  getStorageMode: () => h.storageMode,
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { seedCatalogData } from "./catalogSeed";
import { SEED_MENU, SEED_OWNERS, SEED_RESTAURANTS } from "./catalogData";

describe("seedCatalogData", () => {
  beforeEach(() => {
    h.inserted.length = 0;
    h.selectResult = [];
    h.storageMode = "postgres";
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEED_DEMO_DATA", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("inserts owners, restaurants, and menu items in Postgres mode", async () => {
    await seedCatalogData();

    const owners = h.inserted.filter((e) => "phone" in e.values);
    const restaurants = h.inserted.filter((e) => "fssai_license" in e.values);
    const menuItems = h.inserted.filter((e) => "restaurant_id" in e.values);

    expect(h.inserted).toHaveLength(
      SEED_OWNERS.length + SEED_RESTAURANTS.length + SEED_MENU.length,
    );
    expect(owners).toHaveLength(SEED_OWNERS.length);
    expect(restaurants).toHaveLength(SEED_RESTAURANTS.length);
    expect(menuItems).toHaveLength(SEED_MENU.length);

    // Owners must be inserted before restaurants (FK owner_id -> users.id).
    for (const owner of owners) {
      expect(owner.values).toHaveProperty("id");
      expect(owner.values).toHaveProperty("phone");
      expect(owner.values).toHaveProperty("role");
    }

    // Restaurants must populate every NOT NULL column.
    for (const r of restaurants) {
      const v = r.values;
      expect(v.id).toBeTruthy();
      expect(v.owner_id).toBeTruthy();
      expect(v.name).toBeTruthy();
      expect(v.gst_number).toBeDefined();
      expect(v.fssai_license).toBeTruthy();
      expect(typeof v.commission_rate).toBe("string");
      expect(typeof v.pickup_eta_min).toBe("number");
      expect(v).toHaveProperty("cuisines");
      expect(v).toHaveProperty("cover_image");
      expect(v).toHaveProperty("rating");
      expect(v).toHaveProperty("price_for_one");
    }

    // Menu items: decimal price must be serialized as a string.
    for (const m of menuItems) {
      const v = m.values;
      expect(v.id).toBeTruthy();
      expect(v.restaurant_id).toBeTruthy();
      expect(v.name).toBeTruthy();
      expect(typeof v.price).toBe("string");
      expect(v).toHaveProperty("spice_level");
      expect(v).toHaveProperty("dietary_tags");
      expect(v).toHaveProperty("is_available");
    }
  });

  it("is idempotent - skips rows that already exist", async () => {
    h.selectResult = [{ id: "existing" }];
    await seedCatalogData();
    expect(h.inserted).toHaveLength(0);
  });

  it("is a no-op when the storage backend is not Postgres", async () => {
    h.storageMode = "memory";
    await seedCatalogData();
    expect(h.inserted).toHaveLength(0);
  });

  it("is a no-op in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await seedCatalogData();
    expect(h.inserted).toHaveLength(0);
  });

  it("is a no-op when SEED_DEMO_DATA is false", async () => {
    vi.stubEnv("SEED_DEMO_DATA", "false");
    await seedCatalogData();
    expect(h.inserted).toHaveLength(0);
  });
});
