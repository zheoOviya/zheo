/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// ADMIN-ORDER-OVERRIDE-A2 — REAL-POSTGRES CAS PROOF
//
// NOT part of the memory-mode unit suite. Connects to a dedicated disposable
// Postgres database and forces the REAL DrizzleOrderRepository through the
// exact admin override decision path (read -> precondition -> policy -> CAS)
// so the hybrid design is proven against a real conditional UPDATE.
//
//   HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/admin_override_a2_run" \
//   HARNESS_TAG=RUN_A HARNESS_EXPECT_DB_PREFIX=admin_override_a2 \
//     pnpm exec tsx apps/api/integration/realPgAdminOrderOverrideCas.ts
//
// PROVES (and only claims):
//   P0 production repo smoke (migrations present, DRAFT create works)
//   P1 default CAS transition CONFIRMED -> PREPARING commits
//   P2 stale from_status -> null/CONCURRENT_MODIFICATION; row unchanged
//   P3 admin CAS vs fulfillment CAS concurrently -> exactly one winner
//   P4 terminal (PICKED_UP / CANCELLED) cannot regress
//   P5 two admin CAS writes from the same expected state -> one winner
//
// DOES NOT claim: transaction atomicity of any admin aggregate, payment /
// settlement authority, EventBus durability, commission persistence, or audit
// atomicity with the status write (audit remains post-write/non-transactional).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type {
  OrderRepository,
  OrderDTO,
  CreateOrderInput,
} from "../src/repositories/orderRepository";
import type { OrderStatus } from "@snakzap/types";
import type { AdminOverrideTargetStatus } from "../src/routes/adminOrderOverridePolicy";

const DATABASE_URL = process.env.HARNESS_DATABASE_URL;
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;
const EXPECT_DB_PREFIX = process.env.HARNESS_EXPECT_DB_PREFIX ?? "admin_override_a2";
const ISOLATION_MODE = process.env.HARNESS_ISOLATION_MODE ?? "DISPOSABLE_LOCAL_CLUSTER";

if (!DATABASE_URL) {
  console.error("BLOCKED: HARNESS_DATABASE_URL is not set (no safe Postgres available)");
  process.exit(2);
}

const checks: Array<{ id: string; ok: boolean; detail?: string }> = [];

function check(id: string, ok: boolean, detail?: string): void {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` :: ${detail}` : ""}`);
}

type OverrideOutcome =
  | { ok: true; order: OrderDTO }
  | { ok: false; code: string };

async function main(): Promise<void> {
  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled++;
  });
  process.on("uncaughtException", () => {
    unhandled++;
  });

  const poolMain = new Pool({ connectionString: DATABASE_URL, max: 8, application_name: "aorMain" });
  const poolA = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "aorA" });
  const poolB = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "aorB" });
  const dbMain = drizzle(poolMain) as unknown as DrizzleDb;
  const dbA = drizzle(poolA) as unknown as DrizzleDb;
  const dbB = drizzle(poolB) as unknown as DrizzleDb;

  const { DrizzleOrderRepository } = await import(
    "../src/repositories/drizzle/drizzleOrderRepository"
  );
  const { calculatePriceBreakdown } = await import("../src/services/pricing");
  const { evaluateOverridePolicy } = await import(
    "../src/routes/adminOrderOverridePolicy"
  );

  const orderRepoMain = new DrizzleOrderRepository(dbMain);

  // Exact mirror of the route's decision path. If the route changes, this
  // harness must change with it — it exists to prove the CAS + policy, not to
  // reimplement an independent rule set.
  async function runAdminOverride(
    repo: OrderRepository,
    orderId: string,
    to: AdminOverrideTargetStatus,
    fromStatus: OrderStatus,
    force: boolean,
  ): Promise<OverrideOutcome> {
    const order = await repo.getById(orderId);
    if (!order) return { ok: false, code: "NOT_FOUND" };
    if (order.status !== fromStatus) return { ok: false, code: "CONCURRENT_MODIFICATION" };
    const rejection = evaluateOverridePolicy({ from: fromStatus, to, force });
    if (rejection) return { ok: false, code: "INVALID_TRANSITION" };
    const updated = await repo.transitionStatus(orderId, fromStatus, to);
    if (!updated) return { ok: false, code: "CONCURRENT_MODIFICATION" };
    return { ok: true, order: updated };
  }

  // ---------- environment + isolation ----------
  const versionRes = await poolMain.query<{ version: string; db: string; user: string }>(
    "select version() as version, current_database() as db, current_user as user",
  );
  const version = versionRes.rows[0]!.version;
  const dbName = versionRes.rows[0]!.db;
  const dbUser = versionRes.rows[0]!.user;
  const postgresConfirmed = /PostgreSQL/i.test(version);
  const isolationOk = dbName.startsWith(EXPECT_DB_PREFIX);

  console.log(`POSTGRES_CONFIRMED=${postgresConfirmed ? "YES" : "NO"}`);
  console.log(`ISOLATION_MODE=${ISOLATION_MODE}`);
  console.log(`RUN_TAG=${TAG}`);
  console.log(`DATABASE_NAME=${dbName}`);
  console.log(`DATABASE_USER=${dbUser}`);
  check("P0_POSTGRES_CONFIRMED", postgresConfirmed, version.split(" on ")[0]);
  check("P0_ISOLATION_GUARD", isolationOk, `database '${dbName}' must start with '${EXPECT_DB_PREFIX}'`);
  if (!postgresConfirmed || !isolationOk) {
    console.log("HARNESS_RESULT: FAIL");
    await poolMain.end();
    await poolA.end();
    await poolB.end();
    process.exit(1);
  }

  // ---------- tracking + helpers ----------
  const userIds: string[] = [];
  const restaurantIds: string[] = [];
  const menuItemIds: string[] = [];
  const committedOrderIds: string[] = [];

  const count = async (sqlText: string, params: unknown[]): Promise<number> => {
    const r = await poolMain.query<{ n: number }>(sqlText, params as any[]);
    return Number(r.rows[0]!.n);
  };

  const countIdleInTransaction = async (): Promise<number> =>
    count(
      "select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'",
      [],
    );

  async function seedBase(): Promise<{ userId: string; restaurantId: string; menuItemId: string }> {
    const userId = randomUUID();
    const restaurantId = randomUUID();
    const menuItemId = randomUUID();
    await poolMain.query("insert into users (id, phone) values ($1,$2)", [
      userId,
      `aor-${TAG}-${userId.slice(0, 8)}`,
    ]);
    await poolMain.query(
      "insert into restaurants (id, owner_id, name, gst_number, fssai_license) values ($1,$2,$3,$4,$5)",
      [
        restaurantId,
        userId,
        `Override ${TAG}`,
        `GST-${TAG}-${restaurantId.slice(0, 8)}`,
        `FSSAI-${TAG}-${restaurantId.slice(0, 8)}`,
      ],
    );
    await poolMain.query(
      "insert into menu_items (id, restaurant_id, name, price) values ($1,$2,$3,$4)",
      [menuItemId, restaurantId, `Override Item ${TAG}`, "100.00"],
    );
    userIds.push(userId);
    restaurantIds.push(restaurantId);
    menuItemIds.push(menuItemId);
    return { userId, restaurantId, menuItemId };
  }

  function createInput(base: {
    userId: string;
    restaurantId: string;
    menuItemId: string;
  }): CreateOrderInput {
    const lines = [
      {
        menu_item_id: base.menuItemId,
        name: `Override Item ${TAG}`,
        base_price: 100,
        quantity: 1,
        customizations: [],
      },
    ];
    const breakdown = calculatePriceBreakdown(lines);
    return {
      user_id: base.userId,
      restaurant_id: base.restaurantId,
      items: lines.map((line) => ({
        ...line,
        gift_id: null,
        customization_total:
          breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)
            ?.customization_total ?? 0,
        item_subtotal:
          breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)?.item_subtotal ?? 0,
      })),
      breakdown,
    };
  }

  const itemsForOrder = (orderId: string): Promise<number> =>
    count("select count(*)::int as n from order_items where order_id=$1", [orderId]);

  /** Harness-only setup: create an order directly in a given status. */
  async function seedOrderAt(status: OrderStatus): Promise<OrderDTO> {
    const base = await seedBase();
    const created = await orderRepoMain.create(createInput(base));
    committedOrderIds.push(created.id);
    if (status !== "DRAFT") {
      await orderRepoMain.updateStatus(created.id, status);
    }
    return (await orderRepoMain.getById(created.id))!;
  }

  // ============================================================
  // P0 — PRODUCTION REPOSITORY SMOKE
  // ============================================================
  const p0Base = await seedBase();
  const p0Order = await orderRepoMain.create(createInput(p0Base));
  committedOrderIds.push(p0Order.id);
  const p0Loaded = await orderRepoMain.getById(p0Order.id);
  check(
    "P0_SMOKE_DRAFT_CREATE",
    p0Order.status === "DRAFT" && p0Loaded?.status === "DRAFT" && (await itemsForOrder(p0Order.id)) === 1,
    `created=${p0Order.status} loaded=${p0Loaded?.status} items=${await itemsForOrder(p0Order.id)}`,
  );
  console.log(`P0_ORDER=${p0Order.id} P0_STATUS=${p0Loaded?.status}`);

  // ============================================================
  // P1 — DEFAULT CAS CONFIRMED -> PREPARING COMMITS
  // ============================================================
  const p1 = await seedOrderAt("CONFIRMED");
  const p1Res = await runAdminOverride(orderRepoMain, p1.id, "PREPARING", "CONFIRMED", false);
  const p1Persisted = await orderRepoMain.getById(p1.id);
  check(
    "P1_DEFAULT_CAS_CONFIRMED_TO_PREPARING",
    p1Res.ok && p1Res.order.status === "PREPARING" && p1Persisted?.status === "PREPARING",
    `returned=${p1Res.ok ? p1Res.order.status : p1Res.code} persisted=${p1Persisted?.status}`,
  );
  console.log(`P1_ORDER=${p1.id} P1_STATUS=${p1Persisted?.status}`);

  // ============================================================
  // P2 — STALE from_status -> null/CONCURRENT_MODIFICATION, row unchanged
  // ============================================================
  const p2 = await seedOrderAt("PREPARING");
  const p2Res = await runAdminOverride(orderRepoMain, p2.id, "ALMOST_READY", "CONFIRMED", false);
  const p2Persisted = await orderRepoMain.getById(p2.id);
  check(
    "P2_STALE_EXPECTED_NO_WRITE",
    !p2Res.ok && p2Res.code === "CONCURRENT_MODIFICATION" && p2Persisted?.status === "PREPARING",
    `result=${p2Res.ok ? "ok" : p2Res.code} persisted=${p2Persisted?.status}`,
  );
  console.log(`P2_RESULT=${p2Res.ok ? "ok" : p2Res.code} P2_STATUS=${p2Persisted?.status}`);

  // ============================================================
  // P3 — ADMIN CAS vs FULFILLMENT CAS: EXACTLY ONE WINNER
  // ============================================================
  const p3 = await seedOrderAt("CONFIRMED");
  const repoA = new DrizzleOrderRepository(dbA);
  const repoB = new DrizzleOrderRepository(dbB);
  const [p3Admin, p3Fulfill] = await Promise.all([
    runAdminOverride(repoA, p3.id, "PREPARING", "CONFIRMED", false),
    repoB.transitionStatus(p3.id, "CONFIRMED", "PREPARING").then(
      (row) => (row ? { winner: true as const } : { winner: false as const }),
    ),
  ]);
  const p3Winners =
    (p3Admin.ok ? 1 : 0) + (p3Fulfill.winner ? 1 : 0);
  const p3Final = await orderRepoMain.getById(p3.id);
  check(
    "P3_ADMIN_VS_FULFILLMENT_ONE_WINNER",
    p3Winners === 1 && p3Final?.status === "PREPARING",
    `winners=${p3Winners} admin=${p3Admin.ok ? "win" : p3Admin.code} fulfillment=${p3Fulfill.winner ? "win" : "lose"} final=${p3Final?.status}`,
  );
  console.log(`P3_WINNERS=${p3Winners} P3_FINAL=${p3Final?.status}`);

  // ============================================================
  // P4 — TERMINAL STATE CANNOT REGRESS
  // ============================================================
  const p4Picked = await seedOrderAt("PICKED_UP");
  const p4Regress = await runAdminOverride(orderRepoMain, p4Picked.id, "CONFIRMED", "PICKED_UP", true);
  const p4Stale = await runAdminOverride(orderRepoMain, p4Picked.id, "PREPARING", "CONFIRMED", false);
  const p4PickedFinal = await orderRepoMain.getById(p4Picked.id);

  const p4Cancelled = await seedOrderAt("CANCELLED");
  const p4CancelRegress = await runAdminOverride(
    orderRepoMain,
    p4Cancelled.id,
    "CONFIRMED",
    "CANCELLED",
    true,
  );
  const p4CancelledFinal = await orderRepoMain.getById(p4Cancelled.id);

  check(
    "P4_TERMINAL_REGRESSION_BLOCKED",
    !p4Regress.ok &&
      p4Regress.code === "INVALID_TRANSITION" &&
      !p4Stale.ok &&
      p4Stale.code === "CONCURRENT_MODIFICATION" &&
      p4PickedFinal?.status === "PICKED_UP" &&
      !p4CancelRegress.ok &&
      p4CancelRegress.code === "INVALID_TRANSITION" &&
      p4CancelledFinal?.status === "CANCELLED",
    `pickedForce=${p4Regress.ok ? "ok" : p4Regress.code} pickedStale=${p4Stale.ok ? "ok" : p4Stale.code} pickedState=${p4PickedFinal?.status} cancelledForce=${p4CancelRegress.ok ? "ok" : p4CancelRegress.code} cancelledState=${p4CancelledFinal?.status}`,
  );
  console.log(
    `P4_PICKED_UP_STATE=${p4PickedFinal?.status} P4_CANCELLED_STATE=${p4CancelledFinal?.status}`,
  );

  // ============================================================
  // P5 — TWO ADMIN CAS WRITES FROM SAME EXPECTED STATE: ONE WINNER
  // ============================================================
  const p5 = await seedOrderAt("CONFIRMED");
  const [p5A, p5B] = await Promise.all([
    runAdminOverride(repoA, p5.id, "PREPARING", "CONFIRMED", false),
    runAdminOverride(repoB, p5.id, "CANCELLED", "CONFIRMED", false),
  ]);
  const p5Winners = (p5A.ok ? 1 : 0) + (p5B.ok ? 1 : 0);
  const p5Final = await orderRepoMain.getById(p5.id);
  const winnerTarget = p5A.ok ? "PREPARING" : p5B.ok ? "CANCELLED" : "NONE";
  check(
    "P5_TWO_ADMIN_ONE_WINNER",
    p5Winners === 1 && p5Final?.status === winnerTarget,
    `winners=${p5Winners} a=${p5A.ok ? "win" : p5A.code} b=${p5B.ok ? "win" : p5B.code} final=${p5Final?.status} winnerTarget=${winnerTarget}`,
  );
  console.log(`P5_WINNERS=${p5Winners} P5_FINAL=${p5Final?.status} P5_WINNER_TARGET=${winnerTarget}`);

  // ============================================================
  // concurrency + idle verdict
  // ============================================================
  check("REAL_CONCURRENT_TX", p3Winners === 1 && p5Winners === 1, `p3Winners=${p3Winners} p5Winners=${p5Winners}`);
  console.log(`REAL_CONCURRENT_TX=${p3Winners === 1 && p5Winners === 1 ? "YES" : "NO"}`);

  const idleBefore = await countIdleInTransaction();
  console.log(`IDLE_IN_TRANSACTION=${idleBefore} (expect 0)`);
  check("NO_IDLE_IN_TRANSACTION", idleBefore === 0, `idle=${idleBefore}`);

  // ---------- cleanup ----------
  const cleanupQueries: Array<[string, unknown[]]> = [
    ["delete from order_items where order_id = any($1::uuid[])", [committedOrderIds]],
    ["delete from orders where id = any($1::uuid[])", [committedOrderIds]],
    ["delete from menu_items where id = any($1::uuid[])", [menuItemIds]],
    ["delete from restaurants where id = any($1::uuid[])", [restaurantIds]],
    ["delete from users where id = any($1::uuid[])", [userIds]],
  ];
  for (const [sqlText, params] of cleanupQueries) {
    await poolMain.query(sqlText, params as any[]);
  }
  const leftovers =
    (await count("select count(*)::int as n from orders where user_id = any($1::uuid[])", [userIds])) +
    (await count("select count(*)::int as n from order_items where order_id = any($1::uuid[])", [committedOrderIds])) +
    (await count("select count(*)::int as n from users where id = any($1::uuid[])", [userIds]));
  console.log(`CLEANUP_LEFTOVER_TEST_ROWS=${leftovers}`);
  check("CLEANUP_NO_LEFTOVER_ROWS", leftovers === 0, `leftovers=${leftovers}`);

  check("NO_UNHANDLED_REJECTION", unhandled === 0, `unhandled=${unhandled}`);
  console.log(`UNHANDLED_REJECTION_COUNT=${unhandled}`);

  const idleAfter = await countIdleInTransaction();
  console.log(`IDLE_IN_TRANSACTION_FINAL=${idleAfter}`);

  await poolMain.end();
  await poolA.end();
  await poolB.end();
  console.log("OPEN_DB_CONNECTIONS=CLOSED");

  const ok = checks.every((c) => c.ok);
  console.log(`HARNESS_RESULT: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("HARNESS FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
