import { eq } from "drizzle-orm";
import { menu_items, restaurants, users } from "@snakzap/db";
import { getDb } from "../lib/db";
import { logger } from "../lib/logger";
import { getStorageMode } from "../repositories/shared";
import { SEED_MENU, SEED_OWNERS, SEED_RESTAURANTS } from "./catalogData";

// ============================================
// Postgres catalog seed.
// The memory repository seeds itself from catalogData via its constructor,
// but the Drizzle-backed repository reads from the `restaurants`/`menu_items`
// tables, which start empty. This idempotently populates those tables (plus
// the vendor-owner `users` rows referenced by restaurants.owner_id) so a
// fresh Postgres database serves the same demo catalog.
//
// Gated exactly like phase4Demo: dev/staging only, never tests or production.
// ============================================

async function rowExists(
  table: typeof users | typeof restaurants | typeof menu_items,
  id: string,
): Promise<boolean> {
  const db = getDb();
  const rows = (await db.select().from(table).where(eq(table.id, id))) as unknown[];
  return rows.length > 0;
}

export async function seedCatalogData(): Promise<void> {
  const env = process.env.NODE_ENV;
  if (env === "test" || env === "production") return;
  if (process.env.SEED_DEMO_DATA === "false") return;
  if (getStorageMode() !== "postgres") return;

  try {
    const db = getDb();

    for (const owner of SEED_OWNERS) {
      if (await rowExists(users, owner.id)) continue;
      await db.insert(users).values({
        id: owner.id,
        phone: owner.phone,
        role: owner.role,
      });
    }

    for (const r of SEED_RESTAURANTS) {
      if (await rowExists(restaurants, r.id)) continue;
      await db.insert(restaurants).values({
        id: r.id,
        owner_id: r.owner_id,
        name: r.name,
        gst_number: r.gst_number ?? "",
        fssai_license: r.fssai_license ?? "",
        commission_rate: String(r.commission_rate),
        is_active: r.is_active,
        lat: r.lat ?? undefined,
        lng: r.lng ?? undefined,
        pickup_eta_min: r.pickup_eta_min,
        rating: r.rating ?? null,
        cuisines: r.cuisines ?? [],
        price_for_one: r.price_for_one ?? null,
        cover_image: r.cover_image ?? null,
      });
    }

    for (const m of SEED_MENU) {
      if (await rowExists(menu_items, m.id)) continue;
      await db.insert(menu_items).values({
        id: m.id,
        restaurant_id: m.restaurant_id,
        name: m.name,
        price: String(m.price),
        description: m.description ?? null,
        dietary_tags: m.dietary_tags,
        customizations: m.customizations,
        image_url: m.image_url ?? null,
        pos_item_id: m.pos_item_id ?? null,
        is_available: m.is_available,
        spice_level: m.spice_level,
      });
    }

    logger.info({
      message: "catalog_seed_applied",
      owners: SEED_OWNERS.length,
      restaurants: SEED_RESTAURANTS.length,
      menu_items: SEED_MENU.length,
    });
  } catch (err) {
    // Seeding is best-effort; a failure must never block startup.
    logger.error({
      message: "catalog_seed_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
