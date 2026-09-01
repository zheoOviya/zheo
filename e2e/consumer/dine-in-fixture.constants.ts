// Deterministic Dine-In E2E fixture constants (UI8-A-R2).
//
// These MUST mirror apps/api/src/seed/dineInE2eFixture.ts exactly — there is
// deliberately no discovery endpoint. Any drift is caught by the resolve-DTO
// assertions in the dine-in spec (restaurant id / table label are pinned).
//
// The opaque table token is shared with the API seed value and must never be
// printed in test output, logs, or evidence.
export const DINE_IN_FIXTURE_RESTAURANT_ID =
  "a0000000-0000-4000-8000-000000000001";
export const DINE_IN_FIXTURE_RESTAURANT_NAME = "Biryani House";
export const DINE_IN_FIXTURE_TABLE_ID =
  "b0000000-0000-4000-8000-000000000001";
export const DINE_IN_FIXTURE_TABLE_LABEL = "Table 01";
export const DINE_IN_FIXTURE_TABLE_TOKEN =
  "dine-e2e-table-01-opaque-4f3c2a11e2b64d9fa8c0f6b2d7e1a9c4";

export interface DineInFixtureTable {
  id: string;
  label: string;
  token: string;
}

// Mirrors apps/api/src/seed/dineInE2eFixture.ts DINE_IN_FIXTURE_TABLES.
// Table 01 is the first/legacy entry; tracks consume distinct tables so a
// full-file CI run never contends for one live-session slot.
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
