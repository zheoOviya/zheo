/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// ORDER-AGGREGATE-IDEMPOTENCY-A3 — REAL-POSTGRES ATOMICITY PROOF
//
// NOT part of the memory-mode unit suite. Connects to a dedicated disposable
// Postgres database, forces the REAL DrizzleOrderRepository /
// DrizzleGiftRepository / DrizzleOrderCheckoutTransactionPort / OrderingService,
// and exits non-zero on any failed assertion. Events are NOT claimed here
// (Unit tests cover emission ordering); this harness proves only persistence
// atomicity and CAS behaviour.
//
//   HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/checkout_a3_p1_run" \
//   HARNESS_TAG=RUN_A HARNESS_EXPECT_DB_PREFIX=checkout_a3_p1 \
//     pnpm exec tsx apps/api/integration/realPgOrderCheckoutAtomicity.ts
//
// PROVES (and only claims) against real Postgres:
//   P1 create failure rollback: order row AND every order item roll back
//   P2 failure after items / before gift bind: order + items roll back
//   P3 concurrent same-gift checkout: exactly one CAS winner commits; the
//      loser commits ZERO orders and reports GIFT_ALREADY_REDEEMED
//   P4 independent checkouts (gift-free and distinct-gift) both commit
//   P5 failure after gift bind / before commit: aggregate rolls back and the
//      gift is restored unbound
//   P6 success: one complete aggregate (exact item count) with the gift bound
//   P7 after all failures: no orphan items, no dangling gift bindings, and no
//      orders for tracked users beyond the committed winners
//
// DOES NOT claim: memory rollback (memory port is passthrough), durable
// idempotency keys (F2 deferred), admin override (F4), catering CAS (F5),
// order_status_history, or durable event delivery. This is external CI
// evidence; no false CI coverage is claimed.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type {
  OrderCheckoutGiftRepo,
  OrderCheckoutOrderRepo,
  OrderCheckoutTransactionPort,
  OrderCheckoutTxRepos,
} from "../src/repositories/orderCheckoutContracts";
import type { PlaceOrderRequest } from "../src/services/ordering";

const DATABASE_URL = process.env.HARNESS_DATABASE_URL;
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;
const EXPECT_DB_PREFIX = process.env.HARNESS_EXPECT_DB_PREFIX ?? "checkout_a3_p1";
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

// ------------------------------------------------------------
// test-only transaction-port wrappers (NO production code touched)
// ------------------------------------------------------------

function proxyRepos(
  repos: OrderCheckoutTxRepos,
  overrides: {
    create?: (inner: OrderCheckoutOrderRepo["create"]) => OrderCheckoutOrderRepo["create"];
    bindToOrder?: (
      inner: OrderCheckoutGiftRepo["bindToOrder"],
    ) => OrderCheckoutGiftRepo["bindToOrder"];
  },
): OrderCheckoutTxRepos {
  const orders = new Proxy(repos.orders, {
    get(target: any, prop: string | symbol): any {
      if (prop === "create" && overrides.create) {
        return overrides.create(target.create.bind(target));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const gifts = new Proxy(repos.gifts, {
    get(target: any, prop: string | symbol): any {
      if (prop === "bindToOrder" && overrides.bindToOrder) {
        return overrides.bindToOrder(target.bindToOrder.bind(target));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { orders, gifts };
}

class FailAfterCreatePort implements OrderCheckoutTransactionPort {
  constructor(private readonly inner: OrderCheckoutTransactionPort) {}
  runInTransaction<T>(fn: (repos: OrderCheckoutTxRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction((repos) =>
      fn(
        proxyRepos(repos, {
          create: (inner) => async (input) => {
            await inner(input);
            throw new Error("HARNESS_FORCED_FAIL_AFTER_CREATE");
          },
        }),
      ),
    );
  }
}

class FailBeforeBindPort implements OrderCheckoutTransactionPort {
  constructor(private readonly inner: OrderCheckoutTransactionPort) {}
  runInTransaction<T>(fn: (repos: OrderCheckoutTxRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction((repos) =>
      fn(
        proxyRepos(repos, {
          bindToOrder: () => async () => {
            throw new Error("HARNESS_FORCED_FAIL_BEFORE_BIND");
          },
        }),
      ),
    );
  }
}

class FailAfterBindPort implements OrderCheckoutTransactionPort {
  constructor(private readonly inner: OrderCheckoutTransactionPort) {}
  runInTransaction<T>(fn: (repos: OrderCheckoutTxRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction((repos) =>
      fn(
        proxyRepos(repos, {
          bindToOrder: (inner) => async (id, orderId) => {
            await inner(id, orderId);
            throw new Error("HARNESS_FORCED_FAIL_AFTER_BIND");
          },
        }),
      ),
    );
  }
}

class GatedBindPort implements OrderCheckoutTransactionPort {
  constructor(
    private readonly inner: OrderCheckoutTransactionPort,
    private readonly onBound: () => Promise<void>,
  ) {}
  runInTransaction<T>(fn: (repos: OrderCheckoutTxRepos) => Promise<T>): Promise<T> {
    const onBound = this.onBound;
    return this.inner.runInTransaction((repos) =>
      fn(
        proxyRepos(repos, {
          bindToOrder: (inner) => async (id, orderId) => {
            const row = await inner(id, orderId);
            if (row) await onBound();
            return row;
          },
        }),
      ),
    );
  }
}

// ------------------------------------------------------------
// main
// ------------------------------------------------------------

async function main(): Promise<void> {
  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled++;
  });
  process.on("uncaughtException", () => {
    unhandled++;
  });

  const poolMain = new Pool({ connectionString: DATABASE_URL, max: 8, application_name: "ocaMain" });
  const poolA = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "ocaA" });
  const poolB = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "ocaB" });
  const dbMain = drizzle(poolMain) as unknown as DrizzleDb;
  const dbA = drizzle(poolA) as unknown as DrizzleDb;
  const dbB = drizzle(poolB) as unknown as DrizzleDb;

  const { DrizzleOrderRepository } = await import(
    "../src/repositories/drizzle/drizzleOrderRepository"
  );
  const { DrizzleGiftRepository } = await import(
    "../src/repositories/drizzle/drizzleGiftRepository"
  );
  const { DrizzleCatalogRepository } = await import("../src/repositories/catalogRepository");
  const { DrizzleOrderCheckoutTransactionPort } = await import(
    "../src/repositories/drizzle/orderCheckoutTransactionPort"
  );
  const { OrderingService } = await import("../src/services/ordering");
  const { AppError } = await import("../src/middleware/envelope");

  const orderRepoMain = new DrizzleOrderRepository(dbMain);
  const giftRepoMain = new DrizzleGiftRepository(dbMain);
  const catalogMain = new DrizzleCatalogRepository(dbMain);

  const makeService = (handle: DrizzleDb, port?: OrderCheckoutTransactionPort) =>
    new OrderingService(
      new DrizzleOrderRepository(handle),
      catalogMain,
      new DrizzleGiftRepository(handle),
      port ?? new DrizzleOrderCheckoutTransactionPort(handle),
    );

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
  const giftIds: string[] = [];
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

  const waitUntilLocked = async (appName: string, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const n = await count(
        "select count(*)::int as n from pg_stat_activity where datname=current_database() and application_name=$1 and wait_event_type='Lock'",
        [appName],
      );
      if (n > 0) return true;
      await sleep(20);
    }
    return false;
  };

  async function seedBase(): Promise<{ userId: string; restaurantId: string; menuItemId: string }> {
    const userId = randomUUID();
    const restaurantId = randomUUID();
    const menuItemId = randomUUID();
    await poolMain.query("insert into users (id, phone) values ($1,$2)", [
      userId,
      `harness-${TAG}-${userId.slice(0, 8)}`,
    ]);
    await poolMain.query(
      "insert into restaurants (id, owner_id, name, gst_number, fssai_license) values ($1,$2,$3,$4,$5)",
      [
        restaurantId,
        userId,
        `Harness ${TAG}`,
        `GST-${TAG}-${restaurantId.slice(0, 8)}`,
        `FSSAI-${TAG}-${restaurantId.slice(0, 8)}`,
      ],
    );
    await poolMain.query(
      "insert into menu_items (id, restaurant_id, name, price) values ($1,$2,$3,$4)",
      [menuItemId, restaurantId, `Item ${TAG}`, "100.00"],
    );
    userIds.push(userId);
    restaurantIds.push(restaurantId);
    menuItemIds.push(menuItemId);
    return { userId, restaurantId, menuItemId };
  }

  async function seedGift(base: { userId: string; restaurantId: string; menuItemId: string }): Promise<string> {
    const gift = await giftRepoMain.create({
      sender_id: base.userId,
      restaurant_id: base.restaurantId,
      menu_item_id: base.menuItemId,
      item_snapshot: {
        name: "Gift Meal",
        price: 100,
        image_url: null,
        dietary_tags: {},
        spice_level: 0,
        customizations: [],
      },
      price_paid: 100,
      message: null,
      recipient_name: null,
      claim_token: `gt-${TAG}-${randomUUID()}`,
      claim_code: "123456",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await giftRepoMain.markPaid(gift.id);
    await giftRepoMain.markClaimed(gift.id, base.userId);
    giftIds.push(gift.id);
    return gift.id;
  }

  const request = (
    base: { userId: string; restaurantId: string; menuItemId: string },
    opts: { giftId?: string; quantity?: number; lines?: number } = {},
  ): PlaceOrderRequest => {
    const lines = opts.lines ?? 1;
    return {
      user_id: base.userId,
      restaurant_id: base.restaurantId,
      items: Array.from({ length: lines }, (_, i) => ({
        menu_item_id: base.menuItemId,
        quantity: opts.quantity ?? 1,
        customizations: [],
        ...(i === 0 && opts.giftId ? { gift_id: opts.giftId } : {}),
      })),
    };
  };

  const outcome = async <T>(p: Promise<T>): Promise<{ ok: boolean; value?: T; code?: string }> => {
    try {
      const value = await p;
      return { ok: true, value };
    } catch (err) {
      return { ok: false, code: err instanceof AppError ? err.code : String(err) };
    }
  };

  const ordersForUser = (userId: string): Promise<number> =>
    count("select count(*)::int as n from orders where user_id=$1", [userId]);
  const itemsForUser = (userId: string): Promise<number> =>
    count(
      "select count(*)::int as n from order_items oi join orders o on o.id=oi.order_id where o.user_id=$1",
      [userId],
    );

  // ============================================================
  // P1 — CREATE FAILURE ROLLBACK (no gift)
  // ============================================================
  const p1Base = await seedBase();
  let p1Threw = false;
  try {
    await makeService(dbMain, new FailAfterCreatePort(new DrizzleOrderCheckoutTransactionPort(dbMain)))
      .placeOrder(request(p1Base, { lines: 2, quantity: 2 }), { emitOrderCreated: false });
  } catch (err) {
    p1Threw = err instanceof Error && err.message === "HARNESS_FORCED_FAIL_AFTER_CREATE";
  }
  const p1Orders = await ordersForUser(p1Base.userId);
  const p1Items = await itemsForUser(p1Base.userId);
  check("P1_CREATE_FAILURE_ROLLBACK", p1Threw && p1Orders === 0 && p1Items === 0, `threw=${p1Threw} orders=${p1Orders} items=${p1Items}`);
  console.log(`P1_ORDERS=${p1Orders} P1_ITEMS=${p1Items}`);

  // ============================================================
  // P2 — FAILURE AFTER ITEMS / BEFORE GIFT BIND
  // ============================================================
  const p2Base = await seedBase();
  const p2GiftId = await seedGift(p2Base);
  let p2Threw = false;
  try {
    await makeService(dbMain, new FailBeforeBindPort(new DrizzleOrderCheckoutTransactionPort(dbMain)))
      .placeOrder(request(p2Base, { giftId: p2GiftId }), { emitOrderCreated: false });
  } catch (err) {
    p2Threw = err instanceof Error && err.message === "HARNESS_FORCED_FAIL_BEFORE_BIND";
  }
  const p2Orders = await ordersForUser(p2Base.userId);
  const p2Items = await itemsForUser(p2Base.userId);
  const p2Gift = await giftRepoMain.getById(p2GiftId);
  check(
    "P2_BEFORE_BIND_ROLLBACK",
    p2Threw && p2Orders === 0 && p2Items === 0 && p2Gift?.redeemed_order_id === null,
    `threw=${p2Threw} orders=${p2Orders} items=${p2Items} giftBound=${p2Gift?.redeemed_order_id !== null}`,
  );
  console.log(`P2_ORDERS=${p2Orders} P2_ITEMS=${p2Items} P2_GIFT_BOUND=${p2Gift?.redeemed_order_id !== null}`);

  // ============================================================
  // P3 — CONCURRENT SAME-GIFT CHECKOUT
  // ============================================================
  const p3Base = await seedBase();
  const p3GiftId = await seedGift(p3Base);
  const p3Locked = deferred();
  const p3Release = deferred();
  const p3ServiceA = makeService(
    dbA,
    new GatedBindPort(new DrizzleOrderCheckoutTransactionPort(dbA), async () => {
      p3Locked.resolve();
      await p3Release.promise;
    }),
  );
  const p3ServiceB = makeService(dbB);

  const p3Req = request(p3Base, { giftId: p3GiftId });
  const p3PromiseA = outcome(p3ServiceA.placeOrder(p3Req, { emitOrderCreated: false }));
  await withTimeout(p3Locked.promise, 10000, "P3 winner never acquired the gift row lock");
  const p3PromiseB = outcome(p3ServiceB.placeOrder(p3Req, { emitOrderCreated: false }));
  const p3Blocked = await waitUntilLocked("ocaB", 8000);
  p3Release.resolve();
  const [p3ResA, p3ResB] = await Promise.all([p3PromiseA, p3PromiseB]);

  const p3Winners = [p3ResA, p3ResB].filter((r) => r.ok);
  const p3Losers = [p3ResA, p3ResB].filter((r) => !r.ok);
  const p3WinnerOrderId = p3ResA.ok ? p3ResA.value!.id : p3ResB.value?.id;
  if (p3WinnerOrderId) committedOrderIds.push(p3WinnerOrderId);
  const p3Gift = await giftRepoMain.getById(p3GiftId);
  const p3Orders = await ordersForUser(p3Base.userId);
  const p3Items = await itemsForUser(p3Base.userId);

  check("P3_ONE_WINNER_ONE_LOSER", p3Winners.length === 1 && p3Losers.length === 1, `winners=${p3Winners.length} losers=${p3Losers.length}`);
  check("P3_LOSER_GIFT_ALREADY_REDEEMED", p3Losers[0]?.code === "GIFT_ALREADY_REDEEMED", `loserCode=${p3Losers[0]?.code}`);
  check("P3_GIFT_BOUND_TO_WINNER", p3Gift?.redeemed_order_id === p3WinnerOrderId && p3WinnerOrderId !== undefined, `giftBound=${p3Gift?.redeemed_order_id} winner=${p3WinnerOrderId}`);
  check("P3_LOSER_COMMITS_NOTHING", p3Orders === 1 && p3Items === 1, `orders=${p3Orders} items=${p3Items}`);
  check("P3_LOSER_BLOCKED_ON_ROW_LOCK", p3Blocked, `lockObserved=${p3Blocked}`);
  console.log(`P3_WINNER_SIDE=${p3ResA.ok ? "A" : "B"} P3_LOSER_CODE=${p3Losers[0]?.code} P3_ORDERS=${p3Orders}`);

  // ============================================================
  // P4 — INDEPENDENT CHECKOUTS BOTH COMMIT
  // ============================================================
  const p4BaseA = await seedBase();
  const p4BaseB = await seedBase();
  const p4GiftId = await seedGift(p4BaseB);
  const [p4ResA, p4ResB] = await Promise.all([
    outcome(makeService(dbA).placeOrder(request(p4BaseA), { emitOrderCreated: false })),
    outcome(makeService(dbB).placeOrder(request(p4BaseB, { giftId: p4GiftId }), { emitOrderCreated: false })),
  ]);
  if (p4ResA.ok && p4ResA.value) committedOrderIds.push(p4ResA.value.id);
  if (p4ResB.ok && p4ResB.value) committedOrderIds.push(p4ResB.value.id);
  const p4Gift = await giftRepoMain.getById(p4GiftId);
  const p4OrdersA = await ordersForUser(p4BaseA.userId);
  const p4OrdersB = await ordersForUser(p4BaseB.userId);
  check("P4_INDEPENDENT_BOTH_COMMIT", p4ResA.ok && p4ResB.ok && p4OrdersA === 1 && p4OrdersB === 1, `okA=${p4ResA.ok} okB=${p4ResB.ok} ordersA=${p4OrdersA} ordersB=${p4OrdersB}`);
  check("P4_DISTINCT_GIFT_BOUND", p4ResB.ok && p4Gift?.redeemed_order_id === p4ResB.value!.id, `giftBound=${p4Gift?.redeemed_order_id} orderB=${p4ResB.value?.id}`);
  console.log(`P4_A_OK=${p4ResA.ok} P4_B_OK=${p4ResB.ok}`);

  // ============================================================
  // P5 — FAILURE AFTER GIFT BIND / BEFORE COMMIT
  // ============================================================
  const p5Base = await seedBase();
  const p5GiftId = await seedGift(p5Base);
  let p5Threw = false;
  try {
    await makeService(dbMain, new FailAfterBindPort(new DrizzleOrderCheckoutTransactionPort(dbMain)))
      .placeOrder(request(p5Base, { giftId: p5GiftId }), { emitOrderCreated: false });
  } catch (err) {
    p5Threw = err instanceof Error && err.message === "HARNESS_FORCED_FAIL_AFTER_BIND";
  }
  const p5Orders = await ordersForUser(p5Base.userId);
  const p5Items = await itemsForUser(p5Base.userId);
  const p5Gift = await giftRepoMain.getById(p5GiftId);
  check(
    "P5_AFTER_BIND_ROLLBACK_RESTORES_GIFT",
    p5Threw && p5Orders === 0 && p5Items === 0 && p5Gift?.redeemed_order_id === null && p5Gift?.status === "CLAIMED",
    `threw=${p5Threw} orders=${p5Orders} items=${p5Items} gift=${p5Gift?.status} bound=${p5Gift?.redeemed_order_id !== null}`,
  );
  console.log(`P5_ORDERS=${p5Orders} P5_ITEMS=${p5Items} P5_GIFT_BOUND=${p5Gift?.redeemed_order_id !== null}`);

  // ============================================================
  // P6 — SUCCESS AGGREGATE COMPLETENESS
  // ============================================================
  const p6Base = await seedBase();
  const p6GiftId = await seedGift(p6Base);
  const p6Res = await makeService(dbMain).placeOrder(
    request(p6Base, { giftId: p6GiftId, lines: 2, quantity: 3 }),
    { emitOrderCreated: false },
  );
  committedOrderIds.push(p6Res.id);
  const p6Loaded = await orderRepoMain.getById(p6Res.id);
  const p6Gift = await giftRepoMain.getById(p6GiftId);
  const p6ItemRows = await count("select count(*)::int as n from order_items where order_id=$1", [p6Res.id]);
  check(
    "P6_SUCCESS_AGGREGATE_COMPLETE",
    p6Loaded !== null && p6Loaded.items.length === 2 && p6ItemRows === 2 && p6Gift?.redeemed_order_id === p6Res.id,
    `loaded=${p6Loaded !== null} items=${p6Loaded?.items.length} itemRows=${p6ItemRows} giftBound=${p6Gift?.redeemed_order_id === p6Res.id}`,
  );
  console.log(`P6_ORDER=${p6Res.id} P6_ITEMS=${p6Loaded?.items.length} P6_GIFT_BOUND=${p6Gift?.redeemed_order_id === p6Res.id}`);

  // ============================================================
  // P7 — NO ORPHANS / DANGLING BINDINGS / PHANTOM ORDERS
  // ============================================================
  const p7OrdersForUsers = await count(
    "select count(*)::int as n from orders where user_id = any($1::uuid[])",
    [userIds],
  );
  const p7DanglingGifts = await count(
    "select count(*)::int as n from gifts where id = any($1::uuid[]) and redeemed_order_id is not null and not (redeemed_order_id = any($2::uuid[]))",
    [giftIds, committedOrderIds],
  );
  const p7OrphanItems = await count(
    "select count(*)::int as n from order_items oi where oi.order_id = any($1::uuid[]) and not exists (select 1 from orders o where o.id = oi.order_id)",
    [committedOrderIds],
  );
  check(
    "P7_NO_PHANTOM_ORDERS",
    p7OrdersForUsers === committedOrderIds.length,
    `ordersForUsers=${p7OrdersForUsers} committed=${committedOrderIds.length}`,
  );
  check("P7_NO_DANGLING_GIFT_BINDINGS", p7DanglingGifts === 0, `dangling=${p7DanglingGifts}`);
  check("P7_NO_ORPHAN_ITEMS", p7OrphanItems === 0, `orphans=${p7OrphanItems}`);
  console.log(`P7_ORDERS_FOR_USERS=${p7OrdersForUsers} P7_COMMITTED=${committedOrderIds.length} P7_DANGLING=${p7DanglingGifts}`);

  // ============================================================
  // concurrency + idle verdict
  // ============================================================
  const realConcurrent = p3Winners.length === 1 && p3Blocked;
  check("REAL_CONCURRENT_TX", realConcurrent, `p3Lock=${p3Blocked}`);
  console.log(`REAL_CONCURRENT_TX=${realConcurrent ? "YES" : "NO"}`);

  const idleBefore = await countIdleInTransaction();
  console.log(`IDLE_IN_TRANSACTION=${idleBefore} (expect 0)`);
  check("NO_IDLE_IN_TRANSACTION", idleBefore === 0, `idle=${idleBefore}`);

  // ---------- cleanup ----------
  const cleanupQueries: Array<[string, unknown[]]> = [
    ["delete from order_items where order_id = any($1::uuid[]) or gift_id = any($2::uuid[])", [committedOrderIds, giftIds]],
    ["delete from orders where id = any($1::uuid[])", [committedOrderIds]],
    ["delete from gifts where id = any($1::uuid[])", [giftIds]],
    ["delete from menu_items where id = any($1::uuid[])", [menuItemIds]],
    ["delete from restaurants where id = any($1::uuid[])", [restaurantIds]],
    ["delete from users where id = any($1::uuid[])", [userIds]],
  ];
  for (const [sqlText, params] of cleanupQueries) {
    await poolMain.query(sqlText, params as any[]);
  }
  const leftovers =
    (await count("select count(*)::int as n from orders where user_id = any($1::uuid[])", [userIds])) +
    (await count("select count(*)::int as n from gifts where id = any($1::uuid[])", [giftIds])) +
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
