import { beforeEach, describe, expect, it } from "vitest";
import { CartPersistenceService, CART_TTL_MS } from "./cartPersistence";

// ============================================
// O09 Cart Persistence (24h inactivity TTL)
// ============================================

describe("CartPersistenceService", () => {
  beforeEach(() => {});

  it("round-trips a saved cart", async () => {
    const service = new CartPersistenceService(undefined, () => new Date("2026-02-01T10:00:00Z"));
    await service.saveCart("u-1", [
      { menu_item_id: "b0000000-0000-4000-8000-000000000001", quantity: 2 },
    ]);

    const loaded = await service.loadCart("u-1");
    expect(loaded.expired).toBe(false);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0]).toMatchObject({ quantity: 2 });
    expect(loaded.saved_at).toBe("2026-02-01T10:00:00.000Z");
  });

  it("returns empty when nothing was saved", async () => {
    const service = new CartPersistenceService(undefined, () => new Date("2026-02-01T10:00:00Z"));
    expect(await service.loadCart("u-nobody")).toEqual({
      items: [],
      expired: false,
      saved_at: null,
      restaurant_id: null,
      restaurant_name: null,
    });
  });

  it("expires a cart after 24h of inactivity", async () => {
    const base = new Date("2026-02-01T10:00:00Z");
    const service = new CartPersistenceService(undefined, () => base);
    await service.saveCart("u-1", [
      { menu_item_id: "b0000000-0000-4000-8000-000000000001", quantity: 1 },
    ]);

    // Advance the clock just past 24h.
    service.now = () => new Date(base.getTime() + CART_TTL_MS + 1000);
    const loaded = await service.loadCart("u-1");
    expect(loaded.expired).toBe(true);
    expect(loaded.items).toHaveLength(0);

    // The snapshot was deleted - a later read shows a clean empty cart.
    const again = await service.loadCart("u-1");
    expect(again.expired).toBe(false);
    expect(again.items).toHaveLength(0);
  });

  it("keeps a cart alive at exactly 24h", async () => {
    const base = new Date("2026-02-01T10:00:00Z");
    const service = new CartPersistenceService(undefined, () => base);
    await service.saveCart("u-1", [
      { menu_item_id: "b0000000-0000-4000-8000-000000000001", quantity: 3 },
    ]);

    service.now = () => new Date(base.getTime() + CART_TTL_MS);
    const loaded = await service.loadCart("u-1");
    expect(loaded.expired).toBe(false);
    expect(loaded.items).toHaveLength(1);
  });

  it("saveCart refreshes the TTL (last write wins)", async () => {
    const base = new Date("2026-02-01T10:00:00Z");
    const service = new CartPersistenceService(undefined, () => base);
    await service.saveCart("u-1", [{ menu_item_id: "x", quantity: 1 }]);

    const later = new Date(base.getTime() + 12 * 60 * 60 * 1000);
    service.now = () => later;
    await service.saveCart("u-1", [{ menu_item_id: "y", quantity: 4 }]);

    service.now = () => new Date(later.getTime() + CART_TTL_MS - 1000);
    const loaded = await service.loadCart("u-1");
    expect(loaded.expired).toBe(false);
    expect(loaded.items[0]).toMatchObject({ menu_item_id: "y", quantity: 4 });
  });

  it("deleteCart clears the snapshot", async () => {
    const service = new CartPersistenceService(undefined, () => new Date("2026-02-01T10:00:00Z"));
    await service.saveCart("u-1", [{ menu_item_id: "x", quantity: 1 }]);
    await service.deleteCart("u-1");
    expect(await service.loadCart("u-1")).toEqual({
      items: [],
      expired: false,
      saved_at: null,
      restaurant_id: null,
      restaurant_name: null,
    });
  });
});
