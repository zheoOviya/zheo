import { logger } from "../lib/logger";
import { getStorageMode } from "../repositories/shared";
import { getDineInE2eSeedRepos } from "../repositories/dineInComposition";

// ============================================
// Deterministic memory-only Dine-In E2E fixture (UI8-A-R1/R2).
//
// Bootstrap seed that makes a fixed set of Dine-In tables resolvable for the
// browser E2E suite. Fail-closed: seeds ONLY when every guard passes
// (explicit DINE_IN_E2E_FIXTURE=true, non-production, memory storage mode).
// It never touches Postgres, never creates a session/order/request/bill, and
// never duplicates the catalog seed (menu items are owned by catalogSeed).
//
// Isolation model: one API process is shared by every Playwright project in a
// full run, so the deterministic tables are statically partitioned into RETRY
// WAVES: 18 logical fixture slots x 3 Playwright attempts (CI retries=2) = 54
// physical tables. Each attempt maps its logical slot to a retry-disjoint
// physical table, so a live session left by a failed attempt can never occupy
// the table a later attempt of the same test resolves. The 18 logical slots are
// unchanged: [0..14] (Table 01-15) are the consumer dine-in tracks (A..H2) and
// [15..17] (Table 16-18) are the vendor dine-in-bills suite. A rerun restarts
// the API process; there is deliberately no runtime reset endpoint and no HTTP
// seed/control surface.
//
//   retry 0 -> indexes  0..17 = Table 01..18
//   retry 1 -> indexes 18..35 = Table 19..36
//   retry 2 -> indexes 36..53 = Table 37..54
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

// Deterministic collection of 54 independent tables under the same fixture
// restaurant: 18 logical slots x 3 Playwright attempts (retry waves).
// [0..14] (Table 01-15) are the consumer dine-in tracks (A..H2); [15..17]
// (Table 16-18) are the vendor dine-in-bills suite. Each retry wave repeats the
// same 18 logical slots on a disjoint physical table (wave 0 = 0..17, wave 1 =
// 18..35, wave 2 = 36..53), so a failed attempt's leftover live session can
// never collide with its own retry. The one-live-session-per-table product rule
// is preserved per physical table.
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
  {
    id: "b0000000-0000-4000-8000-000000000016",
    label: "Table 16",
    token: "dine-e2e-table-16-opaque-9de79f2cd40bd411645c9f6fe8ddc921",
  },
  {
    id: "b0000000-0000-4000-8000-000000000017",
    label: "Table 17",
    token: "dine-e2e-table-17-opaque-7bbaccd9f483ed9388a5fc0c4314fd95",
  },
  {
    id: "b0000000-0000-4000-8000-000000000018",
    label: "Table 18",
    token: "dine-e2e-table-18-opaque-e7f799f6776859b03df2016e0d86fcbb",
  },
  {
    id: "b0000000-0000-4000-8000-000000000019",
    label: "Table 19",
    token: "dine-e2e-table-19-opaque-61ff4e1f26d29d89e801a8bf65bd7103",
  },
  {
    id: "b0000000-0000-4000-8000-000000000020",
    label: "Table 20",
    token: "dine-e2e-table-20-opaque-9b7cd3befaff0a71648a4827cbd523d5",
  },
  {
    id: "b0000000-0000-4000-8000-000000000021",
    label: "Table 21",
    token: "dine-e2e-table-21-opaque-1d8b852b45ebd169d8ab8a0a56f2c04e",
  },
  {
    id: "b0000000-0000-4000-8000-000000000022",
    label: "Table 22",
    token: "dine-e2e-table-22-opaque-24c7d3942ebc7df420d24dab34c163ed",
  },
  {
    id: "b0000000-0000-4000-8000-000000000023",
    label: "Table 23",
    token: "dine-e2e-table-23-opaque-86be9586d297177c0ec55aa1cd70ed18",
  },
  {
    id: "b0000000-0000-4000-8000-000000000024",
    label: "Table 24",
    token: "dine-e2e-table-24-opaque-8d31cf78aa3d912a7f97a37dac134ae4",
  },
  {
    id: "b0000000-0000-4000-8000-000000000025",
    label: "Table 25",
    token: "dine-e2e-table-25-opaque-202e3bca3ecf06835c669de65bf57b40",
  },
  {
    id: "b0000000-0000-4000-8000-000000000026",
    label: "Table 26",
    token: "dine-e2e-table-26-opaque-5b073a00dd43d019a76e2c9f3baf37f2",
  },
  {
    id: "b0000000-0000-4000-8000-000000000027",
    label: "Table 27",
    token: "dine-e2e-table-27-opaque-794ec4ba60b8f63cecb96ee4ccea7644",
  },
  {
    id: "b0000000-0000-4000-8000-000000000028",
    label: "Table 28",
    token: "dine-e2e-table-28-opaque-35ffe707928d182cabcc617b22febd25",
  },
  {
    id: "b0000000-0000-4000-8000-000000000029",
    label: "Table 29",
    token: "dine-e2e-table-29-opaque-5362821ac5a61dfd4b5a69927cc367f2",
  },
  {
    id: "b0000000-0000-4000-8000-000000000030",
    label: "Table 30",
    token: "dine-e2e-table-30-opaque-5179c56b92b427f43d99eb23e9c0524e",
  },
  {
    id: "b0000000-0000-4000-8000-000000000031",
    label: "Table 31",
    token: "dine-e2e-table-31-opaque-db130ae8c967e40dd6cfe591f6389856",
  },
  {
    id: "b0000000-0000-4000-8000-000000000032",
    label: "Table 32",
    token: "dine-e2e-table-32-opaque-701f5ca4211728203dd1d43f7a646c84",
  },
  {
    id: "b0000000-0000-4000-8000-000000000033",
    label: "Table 33",
    token: "dine-e2e-table-33-opaque-9c5539bd59a600dd221151f0ae5c6e55",
  },
  {
    id: "b0000000-0000-4000-8000-000000000034",
    label: "Table 34",
    token: "dine-e2e-table-34-opaque-45f187eb28628e68d6069b7dba8d7021",
  },
  {
    id: "b0000000-0000-4000-8000-000000000035",
    label: "Table 35",
    token: "dine-e2e-table-35-opaque-0812c0c05c9d7d1813d148e2c6cffb53",
  },
  {
    id: "b0000000-0000-4000-8000-000000000036",
    label: "Table 36",
    token: "dine-e2e-table-36-opaque-241eeb26883b4046562ae187061a4f40",
  },
  {
    id: "b0000000-0000-4000-8000-000000000037",
    label: "Table 37",
    token: "dine-e2e-table-37-opaque-0b70a433437d9ce22104e1c32a64ca5f",
  },
  {
    id: "b0000000-0000-4000-8000-000000000038",
    label: "Table 38",
    token: "dine-e2e-table-38-opaque-5191cd034b6bd801afeea37f2eb7a344",
  },
  {
    id: "b0000000-0000-4000-8000-000000000039",
    label: "Table 39",
    token: "dine-e2e-table-39-opaque-90d20cfba9daa388d4ca774566aac988",
  },
  {
    id: "b0000000-0000-4000-8000-000000000040",
    label: "Table 40",
    token: "dine-e2e-table-40-opaque-06bf75fd4f69ede79138b2d0d93e5dce",
  },
  {
    id: "b0000000-0000-4000-8000-000000000041",
    label: "Table 41",
    token: "dine-e2e-table-41-opaque-e2b93976ef9737de1ddf8505af412d47",
  },
  {
    id: "b0000000-0000-4000-8000-000000000042",
    label: "Table 42",
    token: "dine-e2e-table-42-opaque-6ce3c9d06559d683e15b252e93166726",
  },
  {
    id: "b0000000-0000-4000-8000-000000000043",
    label: "Table 43",
    token: "dine-e2e-table-43-opaque-88652a341fcc2016118d1a2025a4cb5e",
  },
  {
    id: "b0000000-0000-4000-8000-000000000044",
    label: "Table 44",
    token: "dine-e2e-table-44-opaque-943ab7cee19784a397d2ccf2182e8b20",
  },
  {
    id: "b0000000-0000-4000-8000-000000000045",
    label: "Table 45",
    token: "dine-e2e-table-45-opaque-f7b8a5097b7971adc9e73e30428ee032",
  },
  {
    id: "b0000000-0000-4000-8000-000000000046",
    label: "Table 46",
    token: "dine-e2e-table-46-opaque-8ef2db1425154768b3ec582e19ebe71a",
  },
  {
    id: "b0000000-0000-4000-8000-000000000047",
    label: "Table 47",
    token: "dine-e2e-table-47-opaque-522eb7bb05bed4979ad253630eb7e848",
  },
  {
    id: "b0000000-0000-4000-8000-000000000048",
    label: "Table 48",
    token: "dine-e2e-table-48-opaque-1c4caad6a79d577eb566c8ccf4c4c19a",
  },
  {
    id: "b0000000-0000-4000-8000-000000000049",
    label: "Table 49",
    token: "dine-e2e-table-49-opaque-71666165025d77b4ed70b4fddad11228",
  },
  {
    id: "b0000000-0000-4000-8000-000000000050",
    label: "Table 50",
    token: "dine-e2e-table-50-opaque-f117b097c7218d6f4d269046f62d10b7",
  },
  {
    id: "b0000000-0000-4000-8000-000000000051",
    label: "Table 51",
    token: "dine-e2e-table-51-opaque-b0db3fd8c88290f74d91b31828f2a09c",
  },
  {
    id: "b0000000-0000-4000-8000-000000000052",
    label: "Table 52",
    token: "dine-e2e-table-52-opaque-a36f2b5bd0eba52722e485a086f5e6ae",
  },
  {
    id: "b0000000-0000-4000-8000-000000000053",
    label: "Table 53",
    token: "dine-e2e-table-53-opaque-6ad7eab8823ef2fbdb2b06c4007e20b9",
  },
  {
    id: "b0000000-0000-4000-8000-000000000054",
    label: "Table 54",
    token: "dine-e2e-table-54-opaque-ff110ece629ca8722a83e44e0943f360",
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
