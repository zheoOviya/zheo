import type { Express } from "express";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { correlationIdMiddleware } from "../lib/correlation";
import { logger } from "../lib/logger";
import { errorHandler, notFoundHandler } from "../middleware/errorHandler";
import { jwtService } from "../services/jwt";
import type { DineInTransactionRepos } from "../repositories/dineInContracts";
import * as dineInComposition from "../repositories/dineInComposition";
import {
  getDineInE2eSeedRepos,
  getDineInTableResolveRepository,
  getDineInTransactionPort,
  resetDineInState,
} from "../repositories/dineInComposition";
import * as shared from "../repositories/shared";
import { dineInRouter } from "../routes/dineIn";
import {
  DINE_IN_FIXTURE_RESTAURANT_ID,
  DINE_IN_FIXTURE_RESTAURANT_NAME,
  DINE_IN_FIXTURE_TABLE_ID,
  DINE_IN_FIXTURE_TABLE_LABEL,
  DINE_IN_FIXTURE_TABLE_TOKEN,
  seedDineInE2eFixture,
} from "./dineInE2eFixture";

// ------------------------------------------------------------
// UI8-A-R2 memory-only Dine-In E2E fixture.
//
// Verifies the fail-closed guards (flag off / production / postgres), the
// memory seed itself, idempotency, exact display + eligibility projections,
// an empty non-table domain, the shared-repository identity guarantee, and
// that the fixture never leaks the opaque token into logs. A small router
// harness (same stack as app.ts) proves the flag-on resolve DTO and the
// public-vs-authenticated session boundary.
// ------------------------------------------------------------

const TEST_USER_ID = "u00000000-0000-4000-8000-000000000001";

function sharedRepos(): DineInTransactionRepos {
  return (
    getDineInTransactionPort() as unknown as { repos: DineInTransactionRepos }
  ).repos;
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use("/api/v1/dine-in", dineInRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function authHeaders(): Record<string, string> {
  const token = jwtService.signAccessToken({
    sub: TEST_USER_ID,
    phone: "+919876543210",
    role: "CONSUMER",
    device_fingerprint: "fp_test_device_abc1234",
  });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  resetDineInState();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDineInState();
});

describe("UI8-A-R2 fail-closed guards", () => {
  it("1. flag absent/false -> no-op, no seeding, resolve unknown", async () => {
    const seedSpy = vi.spyOn(dineInComposition, "getDineInE2eSeedRepos");
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "false");

    await seedDineInE2eFixture();

    expect(seedSpy).not.toHaveBeenCalled();
    const dto = await getDineInTableResolveRepository().resolveByToken(
      DINE_IN_FIXTURE_TABLE_TOKEN,
    );
    expect(dto).toBeNull();
  });

  it("2. production + flag=true -> explicit refusal, zero seeding, no storage-mode side effect", async () => {
    const seedSpy = vi.spyOn(dineInComposition, "getDineInE2eSeedRepos");
    const storageSpy = vi.spyOn(shared, "getStorageMode");
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");
    vi.stubEnv("NODE_ENV", "production");

    await seedDineInE2eFixture();

    expect(storageSpy).not.toHaveBeenCalled();
    expect(seedSpy).not.toHaveBeenCalled();

    vi.stubEnv("NODE_ENV", "test");
    const dto = await getDineInTableResolveRepository().resolveByToken(
      DINE_IN_FIXTURE_TABLE_TOKEN,
    );
    expect(dto).toBeNull();
  });

  it("3. postgres storage + flag=true -> no seeding, no DB mutation", async () => {
    const seedSpy = vi.spyOn(dineInComposition, "getDineInE2eSeedRepos");
    vi.spyOn(shared, "getStorageMode").mockReturnValue("postgres");
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");

    await seedDineInE2eFixture();

    expect(seedSpy).not.toHaveBeenCalled();
    const dto = await getDineInTableResolveRepository().resolveByToken(
      DINE_IN_FIXTURE_TABLE_TOKEN,
    );
    expect(dto).toBeNull();
  });
});

describe("UI8-A-R2 memory seed", () => {
  it("4. memory + non-production + flag=true -> seed", async () => {
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");

    await seedDineInE2eFixture();

    const dto = await getDineInTableResolveRepository().resolveByToken(
      DINE_IN_FIXTURE_TABLE_TOKEN,
    );
    expect(dto).not.toBeNull();
  });

  it("5. exact restaurant/table display projection", async () => {
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");

    await seedDineInE2eFixture();

    const dto = await getDineInTableResolveRepository().resolveByToken(
      DINE_IN_FIXTURE_TABLE_TOKEN,
    );
    expect(dto).toEqual({
      restaurant: {
        id: DINE_IN_FIXTURE_RESTAURANT_ID,
        name: DINE_IN_FIXTURE_RESTAURANT_NAME,
      },
      table: { id: DINE_IN_FIXTURE_TABLE_ID, label: DINE_IN_FIXTURE_TABLE_LABEL },
      can_start_session: true,
    });
  });

  it("6. eligibility seeded active", async () => {
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");

    await seedDineInE2eFixture();

    const eligibility = await sharedRepos().restaurantEligibility.getEligibility(
      DINE_IN_FIXTURE_RESTAURANT_ID,
    );
    expect(eligibility).toEqual({
      id: DINE_IN_FIXTURE_RESTAURANT_ID,
      is_active: true,
    });
  });

  it("7. double invocation -> exactly one table, no duplicates", async () => {
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");

    await seedDineInE2eFixture();
    await seedDineInE2eFixture();

    const tables = await sharedRepos().restaurantTables.getByRestaurant(
      DINE_IN_FIXTURE_RESTAURANT_ID,
    );
    expect(tables).toHaveLength(1);
    expect(tables[0]!.table_token).toBe(DINE_IN_FIXTURE_TABLE_TOKEN);
  });

  it("8. fixture seeds no session/order/request/bill state", async () => {
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");

    await seedDineInE2eFixture();

    const repos = sharedRepos();
    expect(
      await repos.diningSessions.getByTable(DINE_IN_FIXTURE_TABLE_ID),
    ).toEqual([]);
    expect(
      await repos.staffAssignments.getActiveByRestaurant(
        DINE_IN_FIXTURE_RESTAURANT_ID,
      ),
    ).toEqual([]);
    expect(await repos.dineInOrders.getBySession("no-session")).toEqual([]);
    expect(
      await repos.serviceRequests.getPendingByRestaurant(
        DINE_IN_FIXTURE_RESTAURANT_ID,
      ),
    ).toEqual([]);
    expect(await repos.sessionBills.getBySessionId("no-session")).toBeNull();
  });

  it("9. same repository instance as resolve and session-open paths", async () => {
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");

    await seedDineInE2eFixture();

    const seedRepos = getDineInE2eSeedRepos();
    expect(seedRepos.restaurantTables).toBe(
      getDineInTableResolveRepository(),
    );
    expect(seedRepos.restaurantTables).toBe(
      sharedRepos().restaurantTables,
    );
    expect(seedRepos.restaurantEligibility).toBe(
      sharedRepos().restaurantEligibility,
    );
  });

  it("10. opaque token never appears in log output", async () => {
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockReturnValue(undefined as unknown as ReturnType<typeof logger.warn>);
    const infoSpy = vi
      .spyOn(logger, "info")
      .mockReturnValue(undefined as unknown as ReturnType<typeof logger.info>);
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");

    await seedDineInE2eFixture();

    const serialized = JSON.stringify([
      ...warnSpy.mock.calls,
      ...infoSpy.mock.calls,
    ]);
    expect(serialized).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);
  });
});

describe("UI8-A-R2 route boundary proofs", () => {
  it("resolve returns 200 with exact DTO when fixture flag is on", async () => {
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");
    await seedDineInE2eFixture();

    const res = await request(buildApp())
      .get("/api/v1/dine-in/tables/resolve")
      .query({ token: DINE_IN_FIXTURE_TABLE_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toEqual({
      restaurant: {
        id: DINE_IN_FIXTURE_RESTAURANT_ID,
        name: DINE_IN_FIXTURE_RESTAURANT_NAME,
      },
      table: { id: DINE_IN_FIXTURE_TABLE_ID, label: DINE_IN_FIXTURE_TABLE_LABEL },
      can_start_session: true,
    });
  });

  it("resolve stays public (200 without auth) and sessions stays 401 unauthenticated", async () => {
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");
    await seedDineInE2eFixture();

    const publicResolve = await request(buildApp())
      .get("/api/v1/dine-in/tables/resolve")
      .query({ token: DINE_IN_FIXTURE_TABLE_TOKEN });
    expect(publicResolve.status).toBe(200);

    const noAuth = await request(buildApp())
      .post("/api/v1/dine-in/sessions")
      .send({ table_token: DINE_IN_FIXTURE_TABLE_TOKEN });
    expect(noAuth.status).toBe(401);
  });

  it("POST /sessions succeeds with fixture token when authenticated", async () => {
    vi.stubEnv("DINE_IN_E2E_FIXTURE", "true");
    await seedDineInE2eFixture();

    const res = await request(buildApp())
      .post("/api/v1/dine-in/sessions")
      .set(authHeaders())
      .send({ table_token: DINE_IN_FIXTURE_TABLE_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.session).toMatchObject({
      restaurant_id: DINE_IN_FIXTURE_RESTAURANT_ID,
      status: "OPEN",
    });
  });
});
