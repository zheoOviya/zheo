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
