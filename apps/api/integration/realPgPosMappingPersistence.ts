// ============================================================
// POS-MAPPING-PG-DURABILITY-A2 - REAL-POSTGRES IMPORT PROOF (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV against a disposable, already-migrated DATABASE_URL (migration
// 0019_pos_order_mapping_persistence.sql must have been applied):
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://<user>:<pw>@127.0.0.1:5432/<disposable_db> \
//   apps/api/node_modules/.bin/tsx apps/api/integration/realPgPosMappingPersistence.ts
//
// ISOLATION MODE: established disposable DB + unique run tag + strict
// contamination accounting. A fresh schema is NOT used because 0019's FKs
// target `public.orders`/`public.restaurants` by absolute name; isolating them
// would require rewriting the frozen migration SQL (forbidden).
//
// PROVES (and only claims):
//   P1  live table pos_order_mappings has the EXACT 5-column shape, PK-only +
//       one composite unique index, two exact named FKs, NO unique(order_id),
//       NO cascade, NO extra index/column.
//   P2  a real PetpoojaPosService import persists order + order_items,
//       CONFIRMED status, exactly one mapping; result processed=true.
//   P3  restart durability: the importing pool is CLOSED and a brand-new
//       pool/service reads the same mapping + CONFIRMED order.
//   P4  cross-instance: two independent pools (distinct pg_backend_pid); A
//       imports, B reads the same mapping/order.
//   P5  concurrent same key: one winner commits, the loser hits the DB UNIQUE;
//       exactly one mapping, one durable order, one order's items, no orphan.
//   P6  the loser returns idempotent with the winner's order id and leaves 0
//       extra order/items/mapping.
//   P7  a REAL unrelated 23505 (duplicate phone index) taken from PostgreSQL is
//       rethrown by the import flow, never converted to idempotent.
//   P8  composite independence: (A) same restaurant, different pos id => two
//       orders; (B) different restaurants, same pos id => two orders.
//   P9  deterministic rollback: failure injected AFTER order+items+CONFIRMED
//       but BEFORE the mapping write leaves 0 order/items/mapping/events and
//       deletes no unrelated rows.
//   P10 migration 0019 is pure DDL (no INSERT/UPDATE/DELETE/trigger); an
//       unrelated pre-existing order gains no mapping (NO_FABRICATED_BACKFILL).
//   P11 memory observable contract parity only (scoped lookup, cross-restaurant
//       independence); memory is NOT claimed to provide PG rollback/concurrency.
//   P12 post-commit events: an INDEPENDENT connection verifies order +
//       CONFIRMED + mapping BEFORE an event is counted; winner emits exactly
//       OrderCreated then PosOrderImported with payload { order }; loser emits 0.
//
// Rows created here carry a unique run tag and are left in the disposable DB by
// design (no destructive cleanup of unrelated data).
// ============================================================

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { onEvent } from "../src/lib/eventBus";
import { DrizzleOrderRepository } from "../src/repositories/drizzle/drizzleOrderRepository";
import { DrizzlePosOrderRepository } from "../src/repositories/drizzle/drizzlePosOrderRepository";
import { DrizzlePosImportTransactionPort } from "../src/repositories/drizzle/posImportTransactionPort";
import { DrizzleCatalogRepository } from "../src/repositories/catalogRepository";
import { DrizzleIdentityRepository } from "../src/repositories/drizzle/drizzleIdentityRepository";
import {
  isPosOrderMappingDuplicate,
  MemoryPosOrderRepository,
  POS_ORDER_MAPPING_UNIQUE_CONSTRAINT,
  type PosImportTxRepos,
  type PosOrderRepository,
} from "../src/repositories/posRepository";
import type { DrizzleDb } from "../src/lib/dbType";
import { PetpoojaPosService } from "../src/services/posPetpooja";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("FATAL: DATABASE_URL is required (must point at a disposable, migrated DB)");
  process.exit(2);
}
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV");
  process.exit(2);
}
const dbUrl: string = url;
const TARGET_CONSTRAINT = POS_ORDER_MAPPING_UNIQUE_CONSTRAINT;

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

function makeDb(pool: Pool): DrizzleDb {
  return drizzle(pool) as unknown as DrizzleDb;
}

type RawDb = { execute: (q: unknown) => Promise<{ rows: Record<string, unknown>[] }> };

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function rawRows(db: DrizzleDb, q: unknown): Promise<Record<string, unknown>[]> {
  return (await (db as unknown as RawDb).execute(q)).rows;
}

async function rawExec(db: DrizzleDb, q: unknown): Promise<void> {
  await (db as unknown as RawDb).execute(q);
}

function makeService(db: DrizzleDb, posRepo: PosOrderRepository): PetpoojaPosService {
  return new PetpoojaPosService(
    new DrizzleOrderRepository(db),
    new DrizzleCatalogRepository(db),
    new DrizzleIdentityRepository(db),
    posRepo,
  );
}

/** Walks the (Drizzle-wrapped) error cause chain to the pg SQLSTATE + constraint. */
function pgErrorInfo(err: unknown): { code?: string; constraint?: string } {
  let cur = err as
    | { code?: unknown; constraint?: unknown; cause?: unknown }
    | undefined;
  for (let depth = 0; depth < 6 && cur; depth += 1) {
    if (typeof cur.code === "string") {
      return {
        code: cur.code,
        constraint:
          typeof cur.constraint === "string" ? cur.constraint : undefined,
      };
    }
    cur = cur.cause as typeof cur;
  }
  return {};
}

interface Fixtures {
  ownerId: string;
  restA: string;
  restB: string;
}

async function seedFixtures(db: DrizzleDb, tag: string): Promise<Fixtures> {
  const ownerId = randomUUID();
  await rawExec(
    db,
    sql`INSERT INTO users (id, phone, role, created_at) VALUES (${ownerId}, ${"owner_" + tag}, 'VENDOR_OWNER', now())`,
  );
  const restA = randomUUID();
  const restB = randomUUID();
  for (const [id, name] of [
    [restA, `POSA_${tag}`],
    [restB, `POSB_${tag}`],
  ] as const) {
    await rawExec(
      db,
      sql`INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active, cuisines, pickup_eta_min, created_at)
          VALUES (${id}, ${ownerId}, ${name}, ${"GST" + tag}, ${"FSSAI" + tag}, true, '{}', 20, now())`,
    );
  }
  // Two synced POS items per restaurant. Both venues expose the same POS item ids:
  // the catalog lookup is scoped by restaurant_id, so one payload shape works everywhere.
  for (const restaurantId of [restA, restB] as const) {
    for (const [n, price] of [
      [1, "260.00"],
      [2, "150.00"],
    ] as const) {
      await rawExec(
        db,
        sql`INSERT INTO menu_items (id, restaurant_id, name, price, pos_item_id, is_available, created_at)
            VALUES (${randomUUID()}, ${restaurantId}, ${"Item " + n}, ${price}::numeric, ${"pp-a-" + n}, true, now())`,
      );
    }
  }
  return { ownerId, restA, restB };
}

function buildPayload(
  restaurantId: string,
  posOrderId: string,
  phone: string,
): Record<string, unknown> {
  return {
    pos_order_id: posOrderId,
    restaurant_id: restaurantId,
    customer_phone: phone,
    ordered_at: "2026-08-04T10:00:00.000Z",
    items: [
      { pos_item_id: "pp-a-1", name: "Item 1", quantity: 2, price: 260, customizations: [] },
      { pos_item_id: "pp-a-2", name: "Item 2", quantity: 1, price: 150, customizations: [] },
    ],
  };
}

const SIG = "valid_sig_harness";

async function importVia(
  service: PetpoojaPosService,
  restaurantId: string,
  posOrderId: string,
  phone: string,
): Promise<{ processed: boolean; idempotent: boolean; order_id?: string }> {
  return service.processOrderWebhook(
    JSON.stringify(buildPayload(restaurantId, posOrderId, phone)),
    SIG,
  );
}

async function ordersByPhone(
  db: DrizzleDb,
  phone: string,
): Promise<Array<{ id: string; status: string; restaurant_id: string }>> {
  return rawRows(
    db,
    sql`SELECT o.id, o.status, o.restaurant_id FROM orders o JOIN users u ON u.id = o.user_id WHERE u.phone = ${phone} ORDER BY o.created_at`,
  ) as unknown as Array<{ id: string; status: string; restaurant_id: string }>;
}

async function itemCountByPhone(db: DrizzleDb, phone: string): Promise<number> {
  const rows = await rawRows(
    db,
    sql`SELECT count(*)::int AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN users u ON u.id = o.user_id WHERE u.phone = ${phone}`,
  );
  return rows[0]!.n as number;
}

async function mappingsByPos(
  db: DrizzleDb,
  posOrderId: string,
): Promise<Array<{ id: string; order_id: string; restaurant_id: string; pos_order_id: string }>> {
  return rawRows(
    db,
    sql`SELECT id, order_id, restaurant_id, pos_order_id FROM pos_order_mappings WHERE pos_order_id = ${posOrderId}`,
  ) as unknown as Array<{ id: string; order_id: string; restaurant_id: string; pos_order_id: string }>;
}

async function totalMappings(db: DrizzleDb): Promise<number> {
  const rows = await rawRows(db, sql`SELECT count(*)::int AS n FROM pos_order_mappings`);
  return rows[0]!.n as number;
}

async function totalOrders(db: DrizzleDb): Promise<number> {
  const rows = await rawRows(db, sql`SELECT count(*)::int AS n FROM orders`);
  return rows[0]!.n as number;
}

// ------------------------------------------------------------
// Harness-only seams (DO NOT alter production behaviour):
//  - PrecheckBarrier synchronises the two P5 prechecks so both genuinely miss
//    before either transaction starts.
//  - a sabotaged mapping writer rolls the real transaction back at a fixed
//    point (P7 unrelated error / P9 forced failure).
// ------------------------------------------------------------

class PrecheckBarrier {
  private arrivals = 0;
  private waiters: Array<() => void> = [];

  async hold(): Promise<void> {
    if (this.arrivals >= 2) return;
    this.arrivals += 1;
    if (this.arrivals >= 2) {
      const waiting = this.waiters;
      this.waiters = [];
      waiting.forEach((release) => release());
      return;
    }
    await new Promise<void>((release) => this.waiters.push(release));
  }
}

class BarrierPosRepo implements PosOrderRepository {
  constructor(
    private readonly inner: DrizzlePosOrderRepository,
    private readonly barrier: PrecheckBarrier,
  ) {}

  recordOrder(restaurantId: string, posOrderId: string, orderId: string) {
    return this.inner.recordOrder(restaurantId, posOrderId, orderId);
  }

  async getByPosOrderId(restaurantId: string, posOrderId: string) {
    await this.barrier.hold();
    return this.inner.getByPosOrderId(restaurantId, posOrderId);
  }

  transactionPort(orders: Parameters<NonNullable<PosOrderRepository["transactionPort"]>>[0]) {
    return this.inner.transactionPort(orders);
  }

  _reset(): void {}
}

/** Real outer transaction, but the mapping write throws `error` after the
 *  order + items + CONFIRMED status have already been written. */
function sabotagedMappingRepo(db: DrizzleDb, error: unknown): PosOrderRepository {
  const inner = new DrizzlePosOrderRepository(db);
  const realPort = new DrizzlePosImportTransactionPort(db);
  return {
    recordOrder: (restaurantId, posOrderId, orderId) =>
      inner.recordOrder(restaurantId, posOrderId, orderId),
    getByPosOrderId: (restaurantId, posOrderId) =>
      inner.getByPosOrderId(restaurantId, posOrderId),
    transactionPort: () => ({
      runInTransaction: <T,>(
        fn: (repos: PosImportTxRepos) => Promise<T>,
      ): Promise<T> =>
        realPort.runInTransaction((repos) =>
          fn({
            orders: repos.orders,
            pos: {
              recordOrder: async () => {
                throw error;
              },
              getByPosOrderId: (restaurantId, posOrderId) =>
                repos.pos.getByPosOrderId(restaurantId, posOrderId),
            },
          }),
        ),
    }),
    _reset: () => {},
  };
}

// ------------------------------------------------------------
// Event capture with an INDEPENDENT connection (P12).
// ------------------------------------------------------------

interface EventRecord {
  name: string;
  orderId: string;
  posOrderId?: string;
  committed: boolean;
  orderPayloadOk: boolean;
}

function registerEventCapture(dbEvents: DrizzleDb, events: EventRecord[]): void {
  const orderRepo = new DrizzleOrderRepository(dbEvents);
  const posRepo = new DrizzlePosOrderRepository(dbEvents);

  onEvent("OrderCreated", async (event) => {
    const orderId = event.aggregate_id;
    const payload = event.payload as { order?: { id?: string } };
    const order = await orderRepo.getById(orderId);
    events.push({
      name: "OrderCreated",
      orderId,
      committed: !!order && order.status === "CONFIRMED",
      orderPayloadOk:
        Object.keys(payload).length === 1 && payload.order?.id === orderId,
    });
  });

  onEvent("PosOrderImported", async (event) => {
    const payload = event.payload as {
      order_id: string;
      pos_order_id: string;
      restaurant_id: string;
    };
    const order = await orderRepo.getById(payload.order_id);
    const mapping = await posRepo.getByPosOrderId(
      payload.restaurant_id,
      payload.pos_order_id,
    );
    events.push({
      name: "PosOrderImported",
      orderId: payload.order_id,
      posOrderId: payload.pos_order_id,
      committed: !!order && order.status === "CONFIRMED" && !!mapping,
      orderPayloadOk: true,
    });
  });
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(dbUrl)}`);
  console.log("A2 real-PG POS mapping import proof starting...");
  const tag = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  // Phone-shaped, run-unique customer ids (zod requires ^\+?[0-9]{10,15}$).
  const phoneTag = String(Math.floor(Math.random() * 1e12)).padStart(12, "0");
  const phone = (n: number) => `${phoneTag}${String(n).padStart(2, "0")}`;

  let poolA = new Pool({ connectionString: dbUrl, max: 6 });
  let dbA = makeDb(poolA);
  let serviceA = makeService(dbA, new DrizzlePosOrderRepository(dbA));

  const poolEvents = new Pool({ connectionString: dbUrl, max: 2 });
  const dbEvents = makeDb(poolEvents);
  const events: EventRecord[] = [];
  registerEventCapture(dbEvents, events);

  const poolB = new Pool({ connectionString: dbUrl, max: 2 });
  const dbB = makeDb(poolB);

  try {
    const fx = await seedFixtures(dbA, tag);
    const rowsBefore = {
      orders: await totalOrders(dbA),
      mappings: await totalMappings(dbA),
    };
    console.log(
      `RUN TAG ${tag}; rows before -> orders=${rowsBefore.orders} mappings=${rowsBefore.mappings}`,
    );

    // ---------- P1: schema exact ----------
    const cols = await rawRows(
      dbA,
      sql`SELECT column_name, data_type, udt_name, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_order_mappings'
          ORDER BY ordinal_position`,
    );
    const colNames = cols.map((c) => c.column_name as string);
    assert(
      JSON.stringify(colNames) ===
        JSON.stringify(["id", "pos_order_id", "order_id", "restaurant_id", "created_at"]),
      `P1: unexpected columns ${colNames.join(",")}`,
    );
    const byName = (n: string) => cols.find((c) => c.column_name === n)!;
    assert(
      byName("id").data_type === "uuid" &&
        byName("id").is_nullable === "NO" &&
        String(byName("id").column_default).includes("gen_random_uuid"),
      "P1: id metadata",
    );
    assert(
      byName("pos_order_id").data_type === "text" &&
        byName("pos_order_id").is_nullable === "NO" &&
        byName("pos_order_id").column_default === null,
      "P1: pos_order_id metadata",
    );
    assert(
      byName("order_id").data_type === "uuid" && byName("order_id").is_nullable === "NO",
      "P1: order_id metadata",
    );
    assert(
      byName("restaurant_id").data_type === "uuid" &&
        byName("restaurant_id").is_nullable === "NO",
      "P1: restaurant_id metadata",
    );
    assert(
      byName("created_at").data_type === "timestamp with time zone" &&
        byName("created_at").is_nullable === "NO" &&
        String(byName("created_at").column_default) === "now()",
      "P1: created_at metadata",
    );

    const idx = await rawRows(
      dbA,
      sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='pos_order_mappings'`,
    );
    assert(idx.length === 2, `P1: expected 2 indexes (PK + composite unique), got ${idx.length}`);
    const composite = idx.find((i) => i.indexname === TARGET_CONSTRAINT);
    assert(!!composite, "P1: composite unique index missing");
    assert(
      /UNIQUE/i.test(String(composite!.indexdef)) &&
        /\(restaurant_id, pos_order_id\)/.test(String(composite!.indexdef)),
      `P1: composite unique definition ${String(composite!.indexdef)}`,
    );
    assert(
      !idx.some((i) => /UNIQUE/i.test(String(i.indexdef)) && /\(order_id\)/.test(String(i.indexdef))),
      "P1: unexpected UNIQUE(order_id)",
    );

    const fks = await rawRows(
      dbA,
      sql`SELECT conname, confdeltype,
                 (SELECT relname FROM pg_class WHERE oid = confrelid) AS reftable
          FROM pg_constraint
          WHERE conrelid='public.pos_order_mappings'::regclass AND contype='f'
          ORDER BY conname`,
    );
    assert(fks.length === 2, `P1: expected 2 FKs, got ${fks.length}`);
    const fkMap = new Map(fks.map((f) => [f.conname as string, f]));
    const orderFk = fkMap.get("pos_order_mappings_order_id_fk");
    const restFk = fkMap.get("pos_order_mappings_restaurant_id_fk");
    assert(!!orderFk && orderFk.reftable === "orders", "P1: order_id FK exact/target");
    assert(!!restFk && restFk.reftable === "restaurants", "P1: restaurant_id FK exact/target");
    for (const fk of [orderFk!, restFk!]) {
      assert(fk.confdeltype !== "c", `P1: cascade not allowed on ${String(fk.conname)}`);
    }
    console.log(
      `[P1] pos_order_mappings exact: columns ${colNames.join(", ")}; PK + ${TARGET_CONSTRAINT}; FKs ${fks
        .map((f) => f.conname as string)
        .join(", ")}; no unique(order_id); no cascade`,
    );

    // ---------- P2: first import through the real service ----------
    const phoneP2 = phone(1);
    const posP2 = `pos_p2_${tag}`;
    const rP2 = await importVia(serviceA, fx.restA, posP2, phoneP2);
    assert(rP2.processed === true && rP2.idempotent === false, `P2: result ${JSON.stringify(rP2)}`);
    const ordersP2 = await ordersByPhone(dbA, phoneP2);
    assert(ordersP2.length === 1, `P2: expected 1 order, got ${ordersP2.length}`);
    assert(ordersP2[0]!.status === "CONFIRMED", `P2: status ${ordersP2[0]!.status}`);
    assert(rP2.order_id === ordersP2[0]!.id, "P2: returned order_id mismatch");
    const itemsP2 = await itemCountByPhone(dbA, phoneP2);
    assert(itemsP2 === 2, `P2: expected 2 order_items, got ${itemsP2}`);
    const mapP2 = await mappingsByPos(dbA, posP2);
    assert(mapP2.length === 1, `P2: expected 1 mapping, got ${mapP2.length}`);
    assert(
      mapP2[0]!.restaurant_id === fx.restA && mapP2[0]!.pos_order_id === posP2,
      "P2: mapping identity mismatch",
    );
    assert(mapP2[0]!.order_id === rP2.order_id, "P2: mapping order_id mismatch");
    console.log(
      `[P2] import -> order ${rP2.order_id} CONFIRMED, 2 items, 1 mapping (${posP2})`,
    );

    // ---------- P3: restart durability (close pool, brand-new pool/service) ----------
    await poolA.end();
    poolA = new Pool({ connectionString: dbUrl, max: 4 });
    dbA = makeDb(poolA);
    serviceA = makeService(dbA, new DrizzlePosOrderRepository(dbA));
    const mapP3 = await new DrizzlePosOrderRepository(dbA).getByPosOrderId(fx.restA, posP2);
    assert(!!mapP3 && mapP3.order_id === rP2.order_id, "P3: mapping not durable after restart");
    const orderP3 = await new DrizzleOrderRepository(dbA).getById(rP2.order_id!);
    assert(!!orderP3 && orderP3.status === "CONFIRMED", "P3: order not durable/CONFIRMED");
    console.log(`[P3] restart durability OK (fresh pool reads mapping + CONFIRMED order)`);

    // ---------- P4: cross-instance, independent pids ----------
    const pidA = (await rawRows(dbA, sql`SELECT pg_backend_pid() AS pid`))[0]!.pid as number;
    const pidB = (await rawRows(dbB, sql`SELECT pg_backend_pid() AS pid`))[0]!.pid as number;
    assert(pidA !== pidB, `P4: pools share backend pid ${pidA}`);
    const phoneP4 = phone(2);
    const posP4 = `pos_p4_${tag}`;
    const rP4 = await importVia(serviceA, fx.restA, posP4, phoneP4);
    assert(rP4.processed === true, "P4: instance A import failed");
    const mapP4B = await new DrizzlePosOrderRepository(dbB).getByPosOrderId(fx.restA, posP4);
    assert(!!mapP4B && mapP4B.order_id === rP4.order_id, "P4: instance B cannot read A's mapping");
    const orderP4B = await new DrizzleOrderRepository(dbB).getById(rP4.order_id!);
    assert(!!orderP4B && orderP4B.status === "CONFIRMED", "P4: B cannot read A's CONFIRMED order");
    console.log(`[P4] cross-instance OK (pidA=${pidA} pidB=${pidB})`);

    // ---------- P5/P6: concurrent same key ----------
    const phoneP5 = phone(3);
    const posP5 = `pos_p5_${tag}`;
    // Pre-provision the customer so the contention under test is the POS mapping
    // (restaurant_id, pos_order_id) uniqueness, not an unrelated identity-insert race.
    await rawExec(
      dbA,
      sql`INSERT INTO users (id, phone, role, created_at) VALUES (${randomUUID()}, ${phoneP5}, 'CONSUMER', now())`,
    );
    const barrierService = makeService(
      dbA,
      new BarrierPosRepo(new DrizzlePosOrderRepository(dbA), new PrecheckBarrier()),
    );
    const [ra, rb] = await Promise.all([
      importVia(barrierService, fx.restA, posP5, phoneP5),
      importVia(barrierService, fx.restA, posP5, phoneP5),
    ]);
    const results = [ra, rb];
    const winners = results.filter((r) => r.processed && !r.idempotent);
    const losers = results.filter((r) => !r.processed && r.idempotent);
    assert(winners.length === 1, `P5: expected exactly 1 winner, got ${winners.length}`);
    assert(losers.length === 1, `P5: expected exactly 1 idempotent loser, got ${losers.length}`);
    const winner = winners[0]!;
    const loser = losers[0]!;
    const mapP5 = await mappingsByPos(dbA, posP5);
    assert(mapP5.length === 1, `P5: expected exactly 1 mapping, got ${mapP5.length}`);
    assert(mapP5[0]!.order_id === winner.order_id, "P5: mapping does not point at winner order");
    const ordersP5 = await ordersByPhone(dbA, phoneP5);
    assert(ordersP5.length === 1, `P5: expected exactly 1 durable order, got ${ordersP5.length}`);
    assert(ordersP5[0]!.status === "CONFIRMED", "P5: durable order not CONFIRMED");
    const itemsP5 = await itemCountByPhone(dbA, phoneP5);
    assert(itemsP5 === 2, `P5: expected items of ONE order (2), got ${itemsP5}`);
    console.log(
      `[P5] concurrent same key -> 1 mapping, 1 order, ${itemsP5} items (no orphan). winner=${winner.order_id}`,
    );

    // P6 loser result + zero extra rows.
    assert(loser.order_id === winner.order_id, "P6: loser order_id != winner order_id");
    const loserOrders = ordersP5.filter((o) => o.id !== winner.order_id);
    assert(loserOrders.length === 0, "P6: loser left an extra order");
    console.log(`[P6] loser idempotent -> winner order ${loser.order_id}; 0 extra order/items/mapping`);

    // ---------- P7: REAL unrelated 23505 is rethrown ----------
    const dupPhone = `p7dup_${tag}`;
    await rawExec(
      dbA,
      sql`INSERT INTO users (id, phone, role, created_at) VALUES (${randomUUID()}, ${dupPhone}, 'CONSUMER', now())`,
    );
    let capturedReal: unknown;
    try {
      await rawExec(
        dbA,
        sql`INSERT INTO users (id, phone, role, created_at) VALUES (${randomUUID()}, ${dupPhone}, 'CONSUMER', now())`,
      );
      throw new Error("P7: expected a duplicate-phone 23505");
    } catch (e) {
      capturedReal = e;
    }
    const pgErr = pgErrorInfo(capturedReal);
    assert(pgErr.code === "23505", `P7: expected 23505, got ${String(pgErr.code)}`);
    assert(
      pgErr.constraint !== TARGET_CONSTRAINT,
      "P7: captured constraint must NOT be the target constraint",
    );
    assert(!isPosOrderMappingDuplicate(capturedReal), "P7: unrelated error misclassified as idempotent");
    const svcP7 = makeService(dbA, sabotagedMappingRepo(dbA, capturedReal));
    const phoneP7 = phone(4);
    const posP7 = `pos_p7_${tag}`;
    let p7Threw = false;
    let p7Error: unknown;
    try {
      await importVia(svcP7, fx.restA, posP7, phoneP7);
    } catch (e) {
      p7Threw = true;
      p7Error = e;
    }
    assert(p7Threw, "P7: unrelated 23505 was NOT rethrown (converted to idempotent?)");
    const rethrown = pgErrorInfo(p7Error);
    assert(
      rethrown.code === "23505" && rethrown.constraint === pgErr.constraint,
      "P7: rethrown error does not match the real unrelated 23505",
    );
    assert((await ordersByPhone(dbA, phoneP7)).length === 0, "P7: unrelated failure left an order");
    console.log(
      `[P7] real unrelated 23505 on '${String(pgErr.constraint)}' rethrown (not idempotent); target is '${TARGET_CONSTRAINT}'`,
    );

    // ---------- P8: composite independence ----------
    // (A) same restaurant, different pos_order_id.
    const phoneP8A1 = phone(5);
    const phoneP8A2 = phone(6);
    const posP8A1 = `pos_p8a1_${tag}`;
    const posP8A2 = `pos_p8a2_${tag}`;
    const rA1 = await importVia(serviceA, fx.restA, posP8A1, phoneP8A1);
    const rA2 = await importVia(serviceA, fx.restA, posP8A2, phoneP8A2);
    assert(rA1.processed && rA2.processed && rA1.order_id !== rA2.order_id, "P8A: orders not independent");
    assert((await mappingsByPos(dbA, posP8A1)).length === 1, "P8A: mapping 1 missing");
    assert((await mappingsByPos(dbA, posP8A2)).length === 1, "P8A: mapping 2 missing");
    console.log(`[P8A] same restaurant, different POS ids -> ${rA1.order_id} != ${rA2.order_id}`);

    // (B) different restaurants, SAME pos_order_id.
    const phoneP8B = phone(7);
    const posP8B = `pos_p8b_${tag}`;
    const rB1 = await importVia(serviceA, fx.restA, posP8B, phoneP8B);
    const rB2 = await importVia(serviceA, fx.restB, posP8B, phone(8));
    assert(
      rB1.processed && rB2.processed && rB1.order_id !== rB2.order_id,
      "P8B: cross-restaurant same pos id conflicted",
    );
    const mapB = await mappingsByPos(dbA, posP8B);
    assert(mapB.length === 2, `P8B: expected 2 mappings, got ${mapB.length}`);
    const mapRest = mapB.map((m) => m.restaurant_id).sort();
    assert(
      JSON.stringify(mapRest) === JSON.stringify([fx.restA, fx.restB].sort()),
      "P8B: mappings not split by restaurant",
    );
    console.log(
      `[P8B] restaurant A + ${posP8B} -> ${rB1.order_id}; restaurant B + ${posP8B} -> ${rB2.order_id}`,
    );

    // ---------- P9: deterministic atomic rollback ----------
    const phoneP9 = phone(9);
    const posP9 = `pos_p9_${tag}`;
    const mappingsBeforeP9 = await totalMappings(dbA);
    const ordersBeforeP9 = await totalOrders(dbA);
    const eventsBeforeP9 = events.length;
    const svcP9 = makeService(dbA, sabotagedMappingRepo(dbA, new Error(`P9_FORCED_${tag}`)));
    let p9Threw = false;
    try {
      await importVia(svcP9, fx.restA, posP9, phoneP9);
    } catch {
      p9Threw = true;
    }
    assert(p9Threw, "P9: forced failure was swallowed");
    assert((await ordersByPhone(dbA, phoneP9)).length === 0, "P9: order survived rollback");
    assert((await itemCountByPhone(dbA, phoneP9)) === 0, "P9: order_items survived rollback");
    assert((await mappingsByPos(dbA, posP9)).length === 0, "P9: mapping survived rollback");
    assert(events.length === eventsBeforeP9, "P9: an event was emitted for a rolled-back import");
    assert(
      (await totalMappings(dbA)) === mappingsBeforeP9 && (await totalOrders(dbA)) === ordersBeforeP9,
      "P9: unrelated rows changed during rollback",
    );
    console.log("[P9] rollback -> 0 order, 0 items, 0 mapping, 0 events; unrelated rows intact");

    // ---------- P10: NO FABRICATED BACKFILL ----------
    let repoRoot = process.cwd();
    const relSql = "packages/db/drizzle/0019_pos_order_mapping_persistence.sql";
    for (let i = 0; i < 8 && !existsSync(join(repoRoot, relSql)); i += 1) {
      const parent = dirname(repoRoot);
      if (parent === repoRoot) break;
      repoRoot = parent;
    }
    const migrationSql = readFileSync(join(repoRoot, relSql), "utf8");
    // FK referential actions ("ON UPDATE"/"ON DELETE no action") are pure DDL, not DML.
    const ddlOnly = migrationSql
      .replace(/\bon\s+update\b/gi, "")
      .replace(/\bon\s+delete\b/gi, "");
    assert(
      !/\binsert\b|\bupdate\b|\bdelete\b|\btrigger\b|\bdrop\b|\btruncate\b/i.test(ddlOnly),
      "P10: migration 0019 contains DML/backfill/trigger/drop",
    );
    // An unrelated order already present gains no POS mapping.
    const unrelatedOrderId = randomUUID();
    const unrelatedPhone = phone(10);
    const unrelatedUserId = randomUUID();
    await rawExec(
      dbA,
      sql`INSERT INTO users (id, phone, role, created_at) VALUES (${unrelatedUserId}, ${unrelatedPhone}, 'CONSUMER', now())`,
    );
    const mappingsBeforeUnrelated = await totalMappings(dbA);
    await rawExec(
      dbA,
      sql`INSERT INTO orders (id, user_id, restaurant_id, total_amount, status, is_catering, created_at, updated_at)
          VALUES (${unrelatedOrderId}, ${unrelatedUserId}, ${fx.restA}, 100.00, 'CONFIRMED', false, now(), now())`,
    );
    assert(
      (await totalMappings(dbA)) === mappingsBeforeUnrelated,
      "P10: unrelated order write created a POS mapping",
    );
    console.log("[P10] 0019 pure DDL; unrelated order gains no mapping (NO_FABRICATED_BACKFILL)");

    // ---------- P11: memory observable contract parity (no durability claim) ----------
    const mem = new MemoryPosOrderRepository();
    const mA = await mem.recordOrder("11111111-1111-4111-8111-111111111111", "mem-pos", "mem-order-A");
    const mB = await mem.recordOrder("22222222-2222-4222-8222-222222222222", "mem-pos", "mem-order-B");
    assert(
      (await mem.getByPosOrderId("11111111-1111-4111-8111-111111111111", "mem-pos"))?.order_id ===
        "mem-order-A",
      "P11: memory scoped lookup A",
    );
    assert(
      (await mem.getByPosOrderId("22222222-2222-4222-8222-222222222222", "mem-pos"))?.order_id ===
        "mem-order-B",
      "P11: memory scoped lookup B",
    );
    assert(
      (await mem.getByPosOrderId("11111111-1111-4111-8111-111111111111", "mem-pos"))?.order_id ===
        mA.order_id,
      "P11: memory repeat resolves its own mapping",
    );
    assert(
      (await mem.getByPosOrderId("11111111-1111-4111-8111-111111111111", "absent")) === null,
      "P11: memory miss should be null",
    );
    console.log("[P11] memory contract parity OK (scoped; cross-restaurant independent)");

    // ---------- P12: post-commit events (independent committed visibility) ----------
    const raceEvents = events.filter((e) => e.orderId === winner.order_id);
    const raceNames = raceEvents.map((e) => e.name);
    assert(
      JSON.stringify(raceNames) === JSON.stringify(["OrderCreated", "PosOrderImported"]),
      `P12: expected [OrderCreated, PosOrderImported], got ${raceNames.join(",")}`,
    );
    assert(
      raceEvents.every((e) => e.committed),
      "P12: an event was counted without independently confirmed committed visibility",
    );
    const orderCreatedEvent = raceEvents.find((e) => e.name === "OrderCreated")!;
    assert(orderCreatedEvent.orderPayloadOk, "P12: OrderCreated payload is not exactly { order }/aggregate mismatch");
    // Loser emitted zero: exactly two events exist for the single winner order,
    // and there is only one order for phoneP5 (asserted in P5).
    assert(raceEvents.length === 2, "P12: loser emitted a phantom event");
    console.log(
      `[P12] winner events = [${raceNames.join(", ")}] all with independent committed visibility; loser = 0; payload { order }`,
    );

    const rowsAfter = {
      orders: await totalOrders(dbA),
      mappings: await totalMappings(dbA),
    };
    console.log(`rows after -> orders=${rowsAfter.orders} mappings=${rowsAfter.mappings}`);
    console.log(
      `UNRELATED ROWS PRESERVED: before(orders=${rowsBefore.orders}, mappings=${rowsBefore.mappings}) untouched by tag ${tag}`,
    );
    console.log(`GLOBAL_CONSTRAINT: ${TARGET_CONSTRAINT}`);
    console.log("A2 REAL-PG POS MAPPING IMPORT PROOF PASSED (P1-P12)");
    console.log(`POS_MAPPING_PG_DURABILITY_A2_PART3_HARNESS_PASSED tag=${tag}`);
  } finally {
    await poolA.end().catch(() => undefined);
    await poolB.end().catch(() => undefined);
    await poolEvents.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(
    "A2 REAL-PG POS MAPPING IMPORT FAILED:",
    err instanceof Error ? err.message : err,
  );
  const cause = (err as { cause?: unknown }).cause;
  if (cause) console.error("CAUSE:", cause);
  process.exitCode = 1;
});
