import { logger } from "../lib/logger";
import { getStorageMode } from "../repositories/shared";
import { getDineInE2eSeedRepos } from "../repositories/dineInComposition";

// ============================================
// Deterministic memory-only Dine-In E2E fixture (UI8-A-R1/R2).
//
// Bootstrap seed that makes exactly ONE Dine-In table resolvable for the
// browser E2E suite. Fail-closed: seeds ONLY when every guard passes
// (explicit DINE_IN_E2E_FIXTURE=true, non-production, memory storage mode).
// It never touches Postgres, never creates a session/order/request/bill, and
// never duplicates the catalog seed (menu items are owned by catalogSeed).
//
// Isolation model: fresh API memory process -> fixture seeds once -> one
// ordered browser scenario -> process termination discards all state. A
// rerun restarts the API process; there is deliberately no runtime reset
// endpoint and no HTTP seed/control surface.
//
// The opaque table token is a shared fixture constant (mirrored by the e2e
// suite in e2e/consumer/dine-in-fixture.constants.ts) and must NEVER be
// logged or rendered in the UI.
// ============================================

export const DINE_IN_FIXTURE_RESTAURANT_ID =
  "a0000000-0000-4000-8000-000000000001";
export const DINE_IN_FIXTURE_RESTAURANT_NAME = "Biryani House";
export const DINE_IN_FIXTURE_TABLE_ID =
  "b0000000-0000-4000-8000-000000000001";
export const DINE_IN_FIXTURE_TABLE_LABEL = "Table 01";
// Opaque, >=32 chars, deterministic. Shared with the e2e suite; never logged.
export const DINE_IN_FIXTURE_TABLE_TOKEN =
  "dine-e2e-table-01-opaque-4f3c2a11e2b64d9fa8c0f6b2d7e1a9c4";

// Guard A: explicit flag required — return before touching any Dine-In
// repository (no storage-mode check, no construction side effect).
// Guard B: production always refuses explicitly — zero seeding, no repo
// construction side effect (checked before getStorageMode()).
// Guard C: postgres storage mode refuses — zero DB mutation, Dine-In repos
// never constructed by this fixture.
// Guard D: memory + non-production + flag=true -> seed the shared instances.
export async function seedDineInE2eFixture(): Promise<void> {
  if (process.env.DINE_IN_E2E_FIXTURE !== "true") {
    return;
  }

  if (process.env.NODE_ENV === "production") {
    logger.warn({ message: "dine_in_e2e_fixture_refused_production" });
    return;
  }

  const mode = getStorageMode();
  if (mode !== "memory") {
    logger.warn({
      message: "dine_in_e2e_fixture_refused_storage_mode",
      mode,
    });
    return;
  }

  const { restaurantTables, restaurantEligibility } = getDineInE2eSeedRepos();

  // Idempotency: deterministic table token already present -> no-op, so a
  // double invocation in one process never creates duplicate table state.
  const existing = await restaurantTables.findByToken(
    DINE_IN_FIXTURE_TABLE_TOKEN,
  );
  if (existing) {
    logger.info({ message: "dine_in_e2e_fixture_already_seeded" });
    return;
  }

  restaurantTables._seedRestaurant({
    id: DINE_IN_FIXTURE_RESTAURANT_ID,
    name: DINE_IN_FIXTURE_RESTAURANT_NAME,
    is_active: true,
  });
  restaurantEligibility._seed({
    id: DINE_IN_FIXTURE_RESTAURANT_ID,
    is_active: true,
  });

  const now = new Date().toISOString();
  restaurantTables._seed({
    id: DINE_IN_FIXTURE_TABLE_ID,
    restaurant_id: DINE_IN_FIXTURE_RESTAURANT_ID,
    zone_id: null,
    label: DINE_IN_FIXTURE_TABLE_LABEL,
    table_token: DINE_IN_FIXTURE_TABLE_TOKEN,
    seat_count: 4,
    is_active: true,
    created_at: now,
    updated_at: now,
  });

  logger.info({ message: "dine_in_e2e_fixture_seeded" });
}
