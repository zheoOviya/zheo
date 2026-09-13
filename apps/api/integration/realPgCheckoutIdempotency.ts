/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// ORDER-IDEMPOTENCY-DURABILITY-A2 — REAL-POSTGRES DURABILITY PROOF
//
// NOT part of the memory-mode unit suite. Connects to a dedicated disposable
// Postgres database, applies the real migrations and drives the REAL
// OrderingService + Drizzle checkout transaction port so that durable checkout
// idempotency is proven against actual PG storage, not an in-process Map.
//
//   HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/checkout_a2_p1_run" \
//   HARNESS_TAG=RUN_A HARNESS_EXPECT_DB_PREFIX=checkout_a2 \
//     pnpm exec tsx apps/api/integration/realPgCheckoutIdempotency.ts
//
// PROVES (and only claims):
//   P0 schema smoke: checkout_idempotency table + UNIQUE(user_id,key) index,
//      nullable order_id, FKs to users/orders
//   P1 first checkout claims + attaches the committed order and persists the
//      SHA-256 request fingerprint
//   P2 identical retry replays the SAME order (one order, one claim, no dup)
//   P3 same key + different payload -> 409 IDEMPOTENCY_KEY_REUSED, no order
//   P4 same key across users stays isolated (composite, not global, key)
//   P5 two concurrent checkouts of the same key (separate service instances /
//      DB handles) converge on exactly ONE order
//   P6 a thrown checkout rolls the claim back atomically (key not poisoned)
//   P7 the claim/order survive a fresh pool = process restart durability
//
// DOES NOT claim: payment/settlement authority, EventBus durability, TTL/expiry
// policy, or any change to non-consumer order writers.
// ============================================================

// Force the in-memory Redis stub before the app config is loaded so the harness
// never blocks on a live Redis for OrderCreated fan-out.
process.env.REDIS_URL = "";

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type { CreateOrderInput } from "../src/repositories/orderRepository";
import type { PlaceOrderRequest } from "../src/services/ordering";

const DATABASE_URL = process.env.HARNESS_DATABASE_URL;
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;
const EXPECT_DB_PREFIX = process.env.HARNESS_EXPECT_DB_PREFIX ?? "checkout_a2";
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

async function main(): Promise<void> {
  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled++;
  });
  process.on("uncaughtException", () => {
    unhandled++;
  });

  const pool = new Pool({ connectionString: DATABASE_URL, max: 8, application_name: "checkoutIdemA2" });
  const db = drizzle(pool) as unknown as DrizzleDb;

  const { DrizzleOrderRepository } = await import("../src/repositories/drizzle/drizzleOrderRepository");
  const { DrizzleGiftRepository } = await import("../src/repositories/drizzle/drizzleGiftRepository");
  const { DrizzleCatalogRepository } = await import("../src/repositories/catalogRepository");
  const { DrizzleCheckoutIdempotencyRepository } = await import(
    "../src/repositories/drizzle/drizzleCheckoutIdempotencyRepository"
  );
  const { DrizzleOrderCheckoutTransactionPort, buildOrderCheckoutTxRepos } = await import(
    "../src/repositories/drizzle/orderCheckoutTransactionPort"
  );
  const { OrderingService, canonicalCheckoutFingerprint } = await import("../src/services/ordering");
  const { calculatePriceBreakdown } = await import("../src/services/pricing");

  const makeService = (dbi: DrizzleDb): InstanceType<typeof OrderingService> =>
    new OrderingService(
      new DrizzleOrderRepository(dbi),
      new DrizzleCatalogRepository(dbi),
      new DrizzleGiftRepository(dbi),
      new DrizzleOrderCheckoutTransactionPort(dbi),
      new DrizzleCheckoutIdempotencyRepository(dbi),
    );

  const serviceA = makeService(db);
  const serviceB = makeService(db);

  // ---------- environment + isolation ----------
  const versionRes = await pool.query<{ version: string; db: string }>(
    "select version() as version, current_database() as db",
  );
  const version = versionRes.rows[0]!.version;
  const dbName = versionRes.rows[0]!.db;
  const postgresConfirmed = /PostgreSQL/i.test(version);
  const isolationOk = dbName.startsWith(EXPECT_DB_PREFIX);

  console.log(`POSTGRES_CONFIRMED=${postgresConfirmed ? "YES" : "NO"}`);
  console.log(`ISOLATION_MODE=${ISOLATION_MODE}`);
  console.log(`RUN_TAG=${TAG}`);
  console.log(`DATABASE_NAME=${dbName}`);
  console.log(`PG_VERSION=${version.split(" on ")[0]}`);
  check("P0_POSTGRES_CONFIRMED", postgresConfirmed, version.split(" on ")[0]);
  check("P0_ISOLATION_GUARD", isolationOk, `database '${dbName}' must start with '${EXPECT_DB_PREFIX}'`);
  if (!postgresConfirmed || !isolationOk) {
    console.log("HARNESS_RESULT: FAIL");
    await pool.end();
    process.exit(1);
  }

  const count = async (sqlText: string, params: unknown[]): Promise<number> => {
    const r = await pool.query<{ n: number }>(sqlText, params as any[]);
    return Number(r.rows[0]!.n);
  };
  const countIdleInTransaction = async (): Promise<number> =>
    count(
      "select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'",
      [],
    );

  const userIds: string[] = [];
  const restaurantIds: string[] = [];
  const menuItemIds: string[] = [];
  const orderIds: string[] = [];

  async function seedBase(): Promise<{ userId: string; restaurantId: string; menuItemId: string }> {
    const userId = randomUUID();
    const restaurantId = randomUUID();
    const menuItemId = randomUUID();
    await pool.query("insert into users (id, phone) values ($1,$2)", [
      userId,
      `chk-${TAG}-${userId.slice(0, 8)}`,
    ]);
    await pool.query(
      "insert into restaurants (id, owner_id, name, gst_number, fssai_license) values ($1,$2,$3,$4,$5)",
      [
        restaurantId,
        userId,
        `Idempotency ${TAG}`,
        `GST-${TAG}-${restaurantId.slice(0, 8)}`,
        `FSSAI-${TAG}-${restaurantId.slice(0, 8)}`,
      ],
    );
    await pool.query(
      "insert into menu_items (id, restaurant_id, name, price) values ($1,$2,$3,$4)",
      [menuItemId, restaurantId, `Idempotency Item ${TAG}`, "220.00"],
    );
    userIds.push(userId);
    restaurantIds.push(restaurantId);
    menuItemIds.push(menuItemId);
    return { userId, restaurantId, menuItemId };
  }

  function makeRequest(
    base: { userId: string; restaurantId: string; menuItemId: string },
    quantity = 1,
  ): PlaceOrderRequest {
    return {
      user_id: base.userId,
      restaurant_id: base.restaurantId,
      items: [{ menu_item_id: base.menuItemId, quantity, customizations: [] }],
      scheduling_policy: "pickup-slot",
    };
  }

  function createInputFrom(
    request: PlaceOrderRequest,
    base: { menuItemId: string },
  ): CreateOrderInput {
    const lines = request.items.map((i) => ({
      menu_item_id: i.menu_item_id,
      name: `Idempotency Item ${TAG}`,
      base_price: 220,
      quantity: i.quantity,
      customizations: i.customizations,
    }));
    const breakdown = calculatePriceBreakdown(lines);
    return {
      user_id: request.user_id,
      restaurant_id: request.restaurant_id,
      items: lines.map((line) => ({
        ...line,
        gift_id: null,
        customization_total:
          breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)?.customization_total ?? 0,
        item_subtotal:
          breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)?.item_subtotal ?? 0,
      })),
      breakdown,
    };
  }

  const rawClaim = async (userId: string, key: string) => {
    const r = await pool.query(
      "select id, order_id, request_fingerprint from checkout_idempotency where user_id=$1 and idempotency_key=$2",
      [userId, key],
    );
    return r.rows[0] as
      | { id: string; order_id: string | null; request_fingerprint: string }
      | undefined;
  };

  const claimCount = (userId: string, key: string): Promise<number> =>
    count("select count(*)::int as n from checkout_idempotency where user_id=$1 and idempotency_key=$2", [
      userId,
      key,
    ]);
  const userOrderCount = (userId: string): Promise<number> =>
    count("select count(*)::int as n from orders where user_id=$1", [userId]);

  const base = await seedBase();
  const KEY_1 = `key-${TAG}-1`;

  // ============================================================
  // P0 — SCHEMA: table, composite unique index, nullable order_id, FKs
  // ============================================================
  const tableRes = await pool.query<{ reg: string | null }>(
    "select to_regclass('public.checkout_idempotency')::text as reg",
  );
  const indexRes = await pool.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where schemaname='public' and tablename='checkout_idempotency' and indexname='checkout_idempotency_user_key_uq'",
  );
  const indexDef = indexRes.rows[0]?.indexdef ?? "";
  const colRes = await pool.query<{ column_name: string; is_nullable: string }>(
    "select column_name, is_nullable from information_schema.columns where table_name='checkout_idempotency' and column_name in ('order_id','user_id','idempotency_key','request_fingerprint')",
  );
  const orderIdNullable = colRes.rows.find((c) => c.column_name === "order_id")?.is_nullable === "YES";
  const fkRes = await pool.query<{ foreign_table: string }>(
    `select ccu.table_name as foreign_table
       from information_schema.table_constraints tc
       join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.table_name='checkout_idempotency' and tc.constraint_type='FOREIGN KEY'`,
  );
  const fkTables = fkRes.rows.map((r) => r.foreign_table).sort();
  const p0Ok =
    tableRes.rows[0]?.reg === "checkout_idempotency" &&
    /UNIQUE/i.test(indexDef) &&
    /\(\s*user_id\s*,\s*idempotency_key\s*\)/i.test(indexDef) &&
    orderIdNullable &&
    fkTables.includes("orders") &&
    fkTables.includes("users");
  check(
    "P0_SCHEMA_UNIQUE_AND_FKS",
    p0Ok,
    `table=${tableRes.rows[0]?.reg} index=${indexDef} orderIdNullable=${orderIdNullable} fks=[${fkTables.join(",")}]`,
  );
  console.log(`P0_INDEX_DEF=${indexDef}`);
  console.log(`P0_FK_TABLES=${fkTables.join(",")}`);

  // ============================================================
  // P1 — FIRST CHECKOUT CLAIMS + ATTACHES + PERSISTS FINGERPRINT
  // ============================================================
  const req1 = makeRequest(base, 1);
  const r1 = await serviceA.placeOrderIdempotent(req1, KEY_1);
  orderIds.push(r1.order.id);
  const claim1 = await rawClaim(base.userId, KEY_1);
  const expectedFp = canonicalCheckoutFingerprint(req1);
  const orderRowCount1 = await count("select count(*)::int as n from orders where id=$1", [r1.order.id]);
  check(
    "P1_FIRST_CREATE_CLAIMS_AND_ATTACHES",
    r1.replayed === false &&
      claim1 !== undefined &&
      claim1.order_id === r1.order.id &&
      claim1.request_fingerprint === expectedFp &&
      orderRowCount1 === 1,
    `replayed=${r1.replayed} claimOrder=${claim1?.order_id} order=${r1.order.id} fpMatch=${claim1?.request_fingerprint === expectedFp} rows=${orderRowCount1}`,
  );
  console.log(`P1_ORDER=${r1.order.id} P1_FINGERPRINT=${claim1?.request_fingerprint?.slice(0, 12)}...`);

  // ============================================================
  // P2 — IDENTICAL RETRY REPLAYS THE SAME ORDER (NO DUPLICATES)
  // ============================================================
  const r2 = await serviceB.placeOrderIdempotent(req1, KEY_1);
  const p2Orders = await userOrderCount(base.userId);
  const p2Claims = await claimCount(base.userId, KEY_1);
  check(
    "P2_REPLAY_SAME_ORDER_NO_DUPLICATE",
    r2.replayed === true &&
      r2.order.id === r1.order.id &&
      r2.order.total_amount === r1.order.total_amount &&
      p2Orders === 1 &&
      p2Claims === 1,
    `replayed=${r2.replayed} sameId=${r2.order.id === r1.order.id} amount=${r2.order.total_amount} orders=${p2Orders} claims=${p2Claims}`,
  );
  console.log(`P2_REPLAY_ORDER=${r2.order.id} ORDERS=${p2Orders} CLAIMS=${p2Claims}`);

  // ============================================================
  // P3 — SAME KEY + DIFFERENT PAYLOAD -> 409, NO ORDER
  // ============================================================
  const conflictReq = makeRequest(base, 2);
  let p3Code = "";
  let p3Status = 0;
  try {
    await serviceA.placeOrderIdempotent(conflictReq, KEY_1);
  } catch (err) {
    p3Code = (err as { code?: string }).code ?? "";
    p3Status = (err as { status?: number }).status ?? 0;
  }
  const p3Orders = await userOrderCount(base.userId);
  const claimAfterConflict = await rawClaim(base.userId, KEY_1);
  check(
    "P3_DIFFERENT_PAYLOAD_409",
    p3Code === "IDEMPOTENCY_KEY_REUSED" &&
      p3Status === 409 &&
      p3Orders === 1 &&
      claimAfterConflict?.request_fingerprint === expectedFp &&
      claimAfterConflict?.order_id === r1.order.id,
    `code=${p3Code} status=${p3Status} orders=${p3Orders} claimIntact=${claimAfterConflict?.order_id === r1.order.id}`,
  );
  console.log(`P3_CODE=${p3Code} P3_STATUS=${p3Status} ORDERS=${p3Orders}`);

  // ============================================================
  // P4 — SAME KEY ACROSS USERS STAYS ISOLATED
  // ============================================================
  const other = await seedBase();
  const r4 = await serviceA.placeOrderIdempotent(makeRequest(other, 1), KEY_1);
  orderIds.push(r4.order.id);
  check(
    "P4_CROSS_USER_ISOLATION",
    r4.replayed === false &&
      r4.order.id !== r1.order.id &&
      (await claimCount(base.userId, KEY_1)) === 1 &&
      (await claimCount(other.userId, KEY_1)) === 1,
    `otherReplayed=${r4.replayed} otherOrder=${r4.order.id} user1Claims=${await claimCount(base.userId, KEY_1)} user2Claims=${await claimCount(other.userId, KEY_1)}`,
  );
  console.log(`P4_OTHER_ORDER=${r4.order.id}`);

  // ============================================================
  // P5 — CONCURRENT SAME-KEY CHECKOUTS CONVERGE ON ONE ORDER
  //      (two service instances / independent DB handles)
  // ============================================================
  const concurrent = await seedBase();
  const KEY_5 = `key-${TAG}-5`;
  const [c1, c2] = await Promise.all([
    serviceA.placeOrderIdempotent(makeRequest(concurrent, 1), KEY_5),
    serviceB.placeOrderIdempotent(makeRequest(concurrent, 1), KEY_5),
  ]);
  orderIds.push(c1.order.id);
  const cOrders = await userOrderCount(concurrent.userId);
  const cClaims = await claimCount(concurrent.userId, KEY_5);
  const oneCreator = [c1.replayed, c2.replayed].filter((x) => x === false).length === 1;
  check(
    "P5_CONCURRENT_ONE_ORDER",
    c1.order.id === c2.order.id && oneCreator && cOrders === 1 && cClaims === 1,
    `idsMatch=${c1.order.id === c2.order.id} oneCreator=${oneCreator} orders=${cOrders} claims=${cClaims}`,
  );
  console.log(`P5_ORDER=${c1.order.id} ORDERS=${cOrders} CLAIMS=${cClaims}`);

  // ============================================================
  // P6 — ROLLED-BACK CHECKOUT LEAVES NO CLAIM (ATOMIC, NOT POISONED)
  // ============================================================
  const rollback = await seedBase();
  const KEY_6 = `key-${TAG}-6`;
  const rollbackReq = makeRequest(rollback, 1);
  let rollbackThrew = false;
  try {
    await db.transaction(async (tx) => {
      const repos = buildOrderCheckoutTxRepos(tx as unknown as DrizzleDb);
      await repos.idempotency!.claim({
        user_id: rollback.userId,
        idempotency_key: KEY_6,
        request_fingerprint: canonicalCheckoutFingerprint(rollbackReq),
      });
      await repos.orders.create(createInputFrom(rollbackReq, rollback));
      throw new Error("simulated_commit_failure");
    });
  } catch {
    rollbackThrew = true;
  }
  const claimAfterRollback = await rawClaim(rollback.userId, KEY_6);
  const ordersAfterRollback = await userOrderCount(rollback.userId);
  const retry = await serviceA.placeOrderIdempotent(rollbackReq, KEY_6);
  orderIds.push(retry.order.id);
  check(
    "P6_ROLLBACK_NOT_POISONED",
    rollbackThrew &&
      claimAfterRollback === undefined &&
      ordersAfterRollback === 0 &&
      retry.replayed === false &&
      (await userOrderCount(rollback.userId)) === 1,
    `threw=${rollbackThrew} claimAfter=${claimAfterRollback === undefined ? "absent" : "present"} ordersAfterRollback=${ordersAfterRollback} retryReplayed=${retry.replayed}`,
  );
  console.log(`P6_RETRY_ORDER=${retry.order.id} CLAIM_AFTER_ROLLBACK=${claimAfterRollback ? "present" : "absent"}`);

  // ============================================================
  // P7 — FRESH POOL = PROCESS RESTART DURABILITY
  // ============================================================
  const restartPool = new Pool({ connectionString: DATABASE_URL, max: 4, application_name: "checkoutIdemA2restart" });
  const restartDb = drizzle(restartPool) as unknown as DrizzleDb;
  const restarted = makeService(restartDb);
  const r7 = await restarted.placeOrderIdempotent(req1, KEY_1);
  await restartPool.end();
  check(
    "P7_RESTART_DURABILITY",
    r7.replayed === true && r7.order.id === r1.order.id,
    `replayed=${r7.replayed} sameId=${r7.order.id === r1.order.id}`,
  );
  console.log(`P7_REPLAY_ORDER=${r7.order.id}`);

  // ============================================================
  // concurrency + idle verdict
  // ============================================================
  const idleBefore = await countIdleInTransaction();
  console.log(`IDLE_IN_TRANSACTION=${idleBefore} (expect 0)`);
  check("NO_IDLE_IN_TRANSACTION", idleBefore === 0, `idle=${idleBefore}`);

  // ---------- cleanup ----------
  const cleanupQueries: Array<[string, unknown[]]> = [
    ["delete from checkout_idempotency where user_id = any($1::uuid[])", [userIds]],
    ["delete from order_items where order_id = any($1::uuid[])", [orderIds]],
    ["delete from orders where id = any($1::uuid[])", [orderIds]],
    ["delete from orders where user_id = any($1::uuid[])", [userIds]],
    ["delete from menu_items where id = any($1::uuid[])", [menuItemIds]],
    ["delete from restaurants where id = any($1::uuid[])", [restaurantIds]],
    ["delete from users where id = any($1::uuid[])", [userIds]],
  ];
  for (const [sqlText, params] of cleanupQueries) {
    await pool.query(sqlText, params as any[]);
  }
  const leftovers =
    (await count("select count(*)::int as n from checkout_idempotency where user_id = any($1::uuid[])", [userIds])) +
    (await count("select count(*)::int as n from orders where user_id = any($1::uuid[])", [userIds])) +
    (await count("select count(*)::int as n from users where id = any($1::uuid[])", [userIds]));
  console.log(`CLEANUP_LEFTOVER_TEST_ROWS=${leftovers}`);
  check("CLEANUP_NO_LEFTOVER_ROWS", leftovers === 0, `leftovers=${leftovers}`);

  check("NO_UNHANDLED_REJECTION", unhandled === 0, `unhandled=${unhandled}`);
  console.log(`UNHANDLED_REJECTION_COUNT=${unhandled}`);

  await pool.end();
  console.log("OPEN_DB_CONNECTIONS=CLOSED");

  const ok = checks.every((c) => c.ok);
  console.log(`HARNESS_RESULT: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("HARNESS FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
