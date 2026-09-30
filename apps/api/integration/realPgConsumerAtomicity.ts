// ============================================================
// EVT-C2 — Real PostgreSQL atomic consumer proof (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with a disposable DATABASE_URL, after applying migration 0027
// (the event_consumer_dedup table) and the loyalty/notification tables:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/evt_b1_run \
//   pnpm exec tsx apps/api/integration/realPgConsumerAtomicity.ts
//
// Proves, against real PostgreSQL, that the EVT-C2 consumer transaction port
// commits the dedup marker and the business effect in ONE transaction:
//
//   C2-PG-1  commit:      marker + cashback (wallet + ledger) persist together
//   C2-PG-2  duplicate:   a redelivered event id loses the claim -> ZERO effect
//   C2-PG-3  rollback:    an effect failure rolls back marker + wallet + ledger
//   C2-PG-4  race:        two concurrent duplicate txns -> exactly one effect
//   C2-PG-5  notif commit: marker + notification outbox rows persist together
//   C2-PG-6  notif rollback: effect failure rolls back marker + notification
//   C2-PG-7  stamp rollback: marker + stamp-card row roll back together
//   C2-PG-8  distinct consumers for one event id are independent
//
// Memory mode cannot prove any of this (MEMORY_ATOMICITY_GUARANTEE=NONE); this
// harness is the required evidence.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import {
  DrizzleConsumerTransactionPort,
  type ConsumerTxScope,
} from "../src/repositories/drizzle/consumerTransactionPort";

const maybeUrl = process.env.DATABASE_URL;
if (!maybeUrl) {
  console.error("FATAL: DATABASE_URL is required (must point at the disposable EVT DB)");
  process.exit(2);
}
const url: string = maybeUrl;
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV");
  process.exit(2);
}

const PREFIX = "itrack-c2-";

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

type Exec = (q: unknown) => Promise<unknown>;
const exec = (db: DrizzleDb, q: unknown) =>
  (db as unknown as { execute: Exec }).execute(q);

async function countWhere(db: DrizzleDb, q: unknown): Promise<number> {
  const res = (await exec(db, q)) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

async function markerCount(db: DrizzleDb, consumer: string, eventId: string): Promise<number> {
  return countWhere(
    db,
    sql`SELECT count(*)::text AS n FROM event_consumer_dedup
        WHERE consumer_name = ${consumer} AND event_id = ${eventId}`,
  );
}

async function ledgerCount(db: DrizzleDb, userId: string): Promise<number> {
  return countWhere(
    db,
    sql`SELECT count(*)::text AS n FROM loyalty_ledger WHERE user_id = ${userId}`,
  );
}

async function walletRowCount(db: DrizzleDb, userId: string): Promise<number> {
  return countWhere(
    db,
    sql`SELECT count(*)::text AS n FROM loyalty_wallets WHERE user_id = ${userId}`,
  );
}

async function notificationCount(db: DrizzleDb, userId: string): Promise<number> {
  return countWhere(
    db,
    sql`SELECT count(*)::text AS n FROM notifications WHERE user_id = ${userId}`,
  );
}

async function stampRowCount(db: DrizzleDb, userId: string): Promise<number> {
  return countWhere(
    db,
    sql`SELECT count(*)::text AS n FROM loyalty_stamp_cards WHERE user_id = ${userId}`,
  );
}

type Outcome<T> = { kind: "APPLIED"; value: T } | { kind: "DUPLICATE" };

/** Mirrors the real consumer shape: claim inside the tx, then apply the effect. */
async function consume<T>(
  port: DrizzleConsumerTransactionPort,
  consumer: string,
  eventId: string,
  effect: (scope: ConsumerTxScope) => Promise<T>,
): Promise<Outcome<T>> {
  return port.runInTransaction(async (scope) => {
    const won = await scope.claim(consumer, eventId);
    if (!won) return { kind: "DUPLICATE" };
    const value = await effect(scope);
    return { kind: "APPLIED", value };
  });
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  const port = new DrizzleConsumerTransactionPort(db);

  const userA = randomUUID();
  const userB = randomUUID();
  const userC = randomUUID();
  const phoneC = PREFIX + "c-" + userC.slice(0, 8);

  try {
    const present = (await exec(
      db,
      sql`SELECT to_regclass('event_consumer_dedup') IS NOT NULL AS ok`,
    )) as unknown as { rows: { ok: boolean }[] };
    check(present.rows[0]?.ok === true, "C2-PG-0 event_consumer_dedup table present");

    // The notifications outbox has a user FK; seed the FK target once, committed
    // outside any consumer transaction (FK-free atomicity checks do not need it).
    await exec(
      db,
      sql`INSERT INTO users (id, phone) VALUES (${userC}, ${phoneC}) ON CONFLICT DO NOTHING`,
    );


    // ---------------------------------------------------------
    // C2-PG-1 commit: marker + wallet + ledger persist together
    // ---------------------------------------------------------
    const e1 = randomUUID();
    const r1 = await consume(
      port,
      PREFIX + "retention.cashback",
      e1,
      (scope) => scope.loyalty.creditWallet(userA, 5, "pickup_cashback"),
    );
    check(r1.kind === "APPLIED", "C2-PG-1 claim won on first delivery");
    check((await markerCount(db, PREFIX + "retention.cashback", e1)) === 1, "C2-PG-1 marker committed");
    check((await ledgerCount(db, userA)) === 1, "C2-PG-1 ledger committed");
    check((await walletRowCount(db, userA)) === 1, "C2-PG-1 wallet row committed");

    // ---------------------------------------------------------
    // C2-PG-2 duplicate: loses the claim, ZERO effect
    // ---------------------------------------------------------
    const r2 = await consume(
      port,
      PREFIX + "retention.cashback",
      e1,
      (scope) => scope.loyalty.creditWallet(userA, 5, "pickup_cashback"),
    );
    check(r2.kind === "DUPLICATE", "C2-PG-2 redelivery lost the claim");
    check((await markerCount(db, PREFIX + "retention.cashback", e1)) === 1, "C2-PG-2 marker still one row");
    check((await ledgerCount(db, userA)) === 1, "C2-PG-2 ledger NOT duplicated");

    // ---------------------------------------------------------
    // C2-PG-3 rollback: effect failure rolls marker + effect back
    // ---------------------------------------------------------
    const e3 = randomUUID();
    let threw = false;
    try {
      await consume(port, PREFIX + "retention.cashback", e3, async (scope) => {
        await scope.loyalty.creditWallet(userB, 5, "pickup_cashback");
        throw new Error("c2-force-rollback");
      });
    } catch {
      threw = true;
    }
    check(threw, "C2-PG-3 effect failure propagated out of runInTransaction");
    check((await markerCount(db, PREFIX + "retention.cashback", e3)) === 0, "C2-PG-3 marker rolled back");
    check((await ledgerCount(db, userB)) === 0, "C2-PG-3 ledger rolled back");
    check((await walletRowCount(db, userB)) === 0, "C2-PG-3 wallet row rolled back");

    // ---------------------------------------------------------
    // C2-PG-4 concurrency: two duplicate txns -> exactly one effect
    // ---------------------------------------------------------
    const e4 = randomUUID();
    const consumer4 = PREFIX + "loyalty.order_stamp";
    const [ra, rb] = await Promise.all([
      consume(port, consumer4, e4, (scope) => scope.loyalty.creditWallet(userC, 1, "pickup_cashback")),
      consume(port, consumer4, e4, (scope) => scope.loyalty.creditWallet(userC, 1, "pickup_cashback")),
    ]);
    const applied = [ra, rb].filter((r) => r.kind === "APPLIED").length;
    const duplicates = [ra, rb].filter((r) => r.kind === "DUPLICATE").length;
    check(applied === 1, "C2-PG-4 exactly one concurrent claim wins");
    check(duplicates === 1, "C2-PG-4 exactly one concurrent claim loses");
    check((await markerCount(db, consumer4, e4)) === 1, "C2-PG-4 one marker persisted");
    check((await ledgerCount(db, userC)) === 1, "C2-PG-4 exactly one ledger effect");

    // ---------------------------------------------------------
    // C2-PG-5/PG-6 notification enqueue commit + rollback (FK user required)
    // ---------------------------------------------------------
    const consumerNotif = PREFIX + "notifications.vendor_approved";
    const eComm = randomUUID();
    const rNotif = await consume(port, consumerNotif, eComm, (scope) =>
      scope.notifications.enqueue({
        user_id: userC,
        channel: "sms",
        to_address: "+9100000000",
        body: "c2-notif-commit",
      }),
    );
    check(rNotif.kind === "APPLIED", "C2-PG-5 notification enqueue applied");
    check((await notificationCount(db, userC)) === 1, "C2-PG-5 notification committed");
    check((await markerCount(db, consumerNotif, eComm)) === 1, "C2-PG-5 notif marker committed");

    const eNotifRollback = randomUUID();
    let notifThrew = false;
    try {
      await consume(port, consumerNotif, eNotifRollback, async (scope) => {
        await scope.notifications.enqueue({
          user_id: userC,
          channel: "email",
          to_address: "c2@example.com",
          body: "c2-notif-rollback",
        });
        throw new Error("c2-notif-force-rollback");
      });
    } catch {
      notifThrew = true;
    }
    check(notifThrew, "C2-PG-6 notification effect failure propagated");
    check((await notificationCount(db, userC)) === 1, "C2-PG-6 notification rolled back (still one)");
    check((await markerCount(db, consumerNotif, eNotifRollback)) === 0, "C2-PG-6 notif marker rolled back");

    // ---------------------------------------------------------
    // C2-PG-7 stamp increment rollback
    // ---------------------------------------------------------
    const consumerStamp = PREFIX + "loyalty.order_stamp";
    const restR = randomUUID();
    const eStamp = randomUUID();
    let stampThrew = false;
    try {
      await consume(port, consumerStamp, eStamp, async (scope) => {
        await scope.loyalty.incrementStamp(userC, restR);
        throw new Error("c2-stamp-force-rollback");
      });
    } catch {
      stampThrew = true;
    }
    check(stampThrew, "C2-PG-7 stamp effect failure propagated");
    check((await stampRowCount(db, userC)) === 0, "C2-PG-7 stamp card rolled back");
    check((await markerCount(db, consumerStamp, eStamp)) === 0, "C2-PG-7 stamp marker rolled back");

    // ---------------------------------------------------------
    // C2-PG-8 distinct consumers for one event id are independent
    // ---------------------------------------------------------
    const eShared = randomUUID();
    const cA = PREFIX + "consumer.a";
    const cB = PREFIX + "consumer.b";
    const rcA = await consume(port, cA, eShared, (scope) =>
      scope.loyalty.creditWallet(userC, 1, "pickup_cashback"),
    );
    const rcB = await consume(port, cB, eShared, (scope) =>
      scope.loyalty.creditWallet(userC, 1, "pickup_cashback"),
    );
    check(rcA.kind === "APPLIED" && rcB.kind === "APPLIED", "C2-PG-8 both consumers applied");
    check((await markerCount(db, cA, eShared)) === 1, "C2-PG-8 consumer A marker");
    check((await markerCount(db, cB, eShared)) === 1, "C2-PG-8 consumer B marker");
  } finally {
    await exec(db, sql`DELETE FROM event_consumer_dedup WHERE consumer_name LIKE ${PREFIX + "%"}`);
    await exec(db, sql`DELETE FROM notifications WHERE user_id IN (${userA}, ${userB}, ${userC})`);
    await exec(db, sql`DELETE FROM loyalty_ledger WHERE user_id IN (${userA}, ${userB}, ${userC})`);
    await exec(db, sql`DELETE FROM loyalty_wallets WHERE user_id IN (${userA}, ${userB}, ${userC})`);
    await exec(db, sql`DELETE FROM loyalty_stamp_cards WHERE user_id IN (${userA}, ${userB}, ${userC})`);
    await exec(db, sql`DELETE FROM loyalty_streaks WHERE user_id IN (${userA}, ${userB}, ${userC})`);
    await exec(db, sql`DELETE FROM users WHERE phone LIKE ${PREFIX + "%"}`);
    await pool.end();
  }

  if (failures > 0) {
    console.error(`RESULT: FAIL (${failures} failed)`);
    process.exit(1);
  }
  console.log("RESULT: PASS (all C2 real-PG atomic consumer checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
