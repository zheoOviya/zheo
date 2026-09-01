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

export interface DineInFixtureTable {
  id: string;
  label: string;
  token: string;
}

// Table 01 stays the first/legacy entry so existing assertions keep passing.
export const DINE_IN_FIXTURE_TABLE_ID =
  "b0000000-0000-4000-8000-000000000001";
export const DINE_IN_FIXTURE_TABLE_LABEL = "Table 01";
// Opaque, >=32 chars, deterministic. Shared with the e2e suite; never logged.
export const DINE_IN_FIXTURE_TABLE_TOKEN =
  "dine-e2e-table-01-opaque-4f3c2a11e2b64d9fa8c0f6b2d7e1a9c4";

// Deterministic collection of 15 independent tables under the same fixture
// restaurant. Each track of the full-file browser suite will later consume its
// own table so tracks never contend for the single live-session slot. The
// one-live-session-per-table product rule is preserved per table.
export const DINE_IN_FIXTURE_TABLES: readonly DineInFixtureTable[] = [
  {
    id: "b0000000-0000-4000-8000-000000000001",
    label: "Table 01",
    token: "dine-e2e-table-01-opaque-4f3c2a11e2b64d9fa8c0f6b2d7e1a9c4",
  },
  {
    id: "b0000000-0000-4000-8000-000000000002",
    label: "Table 02",
    token: "dine-e2e-table-02-opaque-6374205ca09c1d2b54aa8c3f5f19fcdd",
  },
  {
    id: "b0000000-0000-4000-8000-000000000003",
    label: "Table 03",
    token: "dine-e2e-table-03-opaque-06bc2f9df98cf6b8b281fb867cc109c3",
  },
  {
    id: "b0000000-0000-4000-8000-000000000004",
    label: "Table 04",
    token: "dine-e2e-table-04-opaque-1151a0f694945943373c9543fec3036b",
  },
  {
    id: "b0000000-0000-4000-8000-000000000005",
    label: "Table 05",
    token: "dine-e2e-table-05-opaque-b79094a71b915b4e2443fd74bcb0ab00",
  },
  {
    id: "b0000000-0000-4000-8000-000000000006",
    label: "Table 06",
    token: "dine-e2e-table-06-opaque-4befcb3cf5a9d6aa0700533effd50216",
  },
  {
    id: "b0000000-0000-4000-8000-000000000007",
    label: "Table 07",
    token: "dine-e2e-table-07-opaque-fa8766da787c72804a9ec68717e5704d",
  },
  {
    id: "b0000000-0000-4000-8000-000000000008",
    label: "Table 08",
    token: "dine-e2e-table-08-opaque-60af1e376edc779b81f9a51a725b9a0d",
  },
  {
    id: "b0000000-0000-4000-8000-000000000009",
    label: "Table 09",
    token: "dine-e2e-table-09-opaque-6b0439feeb3f303876aa73cf4781683c",
  },
  {
    id: "b0000000-0000-4000-8000-000000000010",
    label: "Table 10",
    token: "dine-e2e-table-10-opaque-984204ecf4fc408f5ec4353526907308",
  },
  {
    id: "b0000000-0000-4000-8000-000000000011",
    label: "Table 11",
    token: "dine-e2e-table-11-opaque-be625b84a0b6284fc01b30cf354d1476",
  },
  {
    id: "b0000000-0000-4000-8000-000000000012",
    label: "Table 12",
    token: "dine-e2e-table-12-opaque-c6652e7804292b79e806916250431cde",
  },
  {
    id: "b0000000-0000-4000-8000-000000000013",
    label: "Table 13",
    token: "dine-e2e-table-13-opaque-8ae8b792e4b74feb6ac512ebdeee8162",
  },
  {
    id: "b0000000-0000-4000-8000-000000000014",
    label: "Table 14",
    token: "dine-e2e-table-14-opaque-233f4803b8a7e3feb2676b4cc302f2c7",
  },
  {
    id: "b0000000-0000-4000-8000-000000000015",
    label: "Table 15",
    token: "dine-e2e-table-15-opaque-25580d4f3dc478c0db3a726223f70abd",
  },
] as const;

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

  // Idempotency: deterministic table token already present -> skip that entry,
  // so a double invocation in one process never creates duplicate table state.
  // Skipping only the already-present rows keeps the seed safe to re-run even
  // after a partial seed (e.g. a table removed between runs would be re-added).
  const missing = [];
  for (const t of DINE_IN_FIXTURE_TABLES) {
    const existing = await restaurantTables.findByToken(t.token);
    if (!existing) missing.push(t);
  }
  if (missing.length === 0) {
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
  for (const t of missing) {
    restaurantTables._seed({
      id: t.id,
      restaurant_id: DINE_IN_FIXTURE_RESTAURANT_ID,
      zone_id: null,
      label: t.label,
      table_token: t.token,
      seat_count: 4,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
  }

  logger.info({ message: "dine_in_e2e_fixture_seeded" });
}
