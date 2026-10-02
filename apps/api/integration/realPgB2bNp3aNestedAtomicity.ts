// ============================================================
// EVT-B2B-NP3-A — Real PostgreSQL proof that C2-derived nested events
// are enqueued on the SAME transaction as the dedup claim + business
// effect (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with a disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/evt_b1_run \
//   pnpm exec tsx apps/api/integration/realPgB2bNp3aNestedAtomicity.ts
//
// Proves, per live nested producer, against real PostgreSQL:
//
//   NP3A-PG-ORDER-STAMP  winner -> marker + stamp effect + child outbox commit
//                        duplicate -> zero additional child rows
//                        rollback  -> marker + stamp effect + child all roll back
//   NP3A-PG-GIFT-STAMP   same three invariants
//   NP3A-PG-CASHBACK     same three invariants (wallet + ledger effect)
//   NP3A-PG-STREAK       same three invariants (streak effect, badge condition)
//
// SCOPE NOTE (truthful limitation): this harness drives the actual
// `DrizzleConsumerTransactionPort` scope — the real `tryMarkProcessedInTx`
// marker, the real tx-scoped `DrizzleLoyaltyRepository` effect methods the
// consumers call (`incrementStamp`, `creditWallet`, `recordPickup`) and the
// real outbox enqueue on the same `tx`. It deliberately reproduces the
// consumer's claim -> effect -> enqueue shape rather than dispatching the whole
// HTTP producer flow. The `orders.getById` precondition and the promotions
// sub-write of `applyStreak` are NOT seeded here; the conditional reward/badge
// branching itself is covered by the memory-parity unit tests
// (eventConsumerAtomicity.c2.test.ts) and EVT-C2's own gateway. The property
// proven here is the one NP3-A changes: nested outbox membership in the winning
// consumer transaction. Memory mode cannot prove any of this
// (MEMORY_ATOMICITY_GUARANTEE = NONE).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import { createEventEnvelope } from "../src/lib/eventBus";
import { DrizzleLoyaltyRepository } from "../src/repositories/drizzle/drizzleLoyaltyRepository";
import { DrizzleConsumerTransactionPort } from "../src/repositories/drizzle/consumerTransactionPort";
import type { ConsumerTxScope } from "../src/repositories/consumerTransactionContracts";

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

const PREFIX = "itrack-np3a-";
const CONSUMER_ORDER_STAMP = PREFIX + "loyalty.order_stamp";
const CONSUMER_GIFT_STAMP = PREFIX + "loyalty.gift_stamp";
const CONSUMER_CASHBACK = PREFIX + "retention.cashback";
const CONSUMER_STREAK = PREFIX + "retention.streak";

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

async function countRows(db: DrizzleDb, q: unknown): Promise<number> {
  const res = (await exec(db, q)) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

function markerCount(db: DrizzleDb, consumer: string, eventId: string): Promise<number> {
  return countRows(
    db,
    sql`SELECT count(*)::text AS n FROM event_consumer_dedup
        WHERE consumer_name = ${consumer} AND event_id = ${eventId}`,
  );
}

function outboxById(db: DrizzleDb, eventId: string): Promise<number> {
  return countRows(
    db,
    sql`SELECT count(*)::text AS n FROM event_outbox WHERE event_id = ${eventId}`,
  );
}

function childCount(
  db: DrizzleDb,
  eventName: string,
  aggregateId: string,
): Promise<number> {
  return countRows(
    db,
    sql`SELECT count(*)::text AS n FROM event_outbox
        WHERE event_name = ${eventName} AND aggregate_id = ${aggregateId}`,
  );
}

function stampRowCount(db: DrizzleDb, userId: string): Promise<number> {
  return countRows(
    db,
    sql`SELECT count(*)::text AS n FROM loyalty_stamp_cards WHERE user_id = ${userId}`,
  );
}

function ledgerCount(db: DrizzleDb, userId: string): Promise<number> {
  return countRows(
    db,
    sql`SELECT count(*)::text AS n FROM loyalty_ledger WHERE user_id = ${userId}`,
  );
}

function walletRowCount(db: DrizzleDb, userId: string): Promise<number> {
  return countRows(
    db,
    sql`SELECT count(*)::text AS n FROM loyalty_wallets WHERE user_id = ${userId}`,
  );
}

async function streakCurrent(db: DrizzleDb, userId: string): Promise<number | null> {
  const res = (await exec(
    db,
    sql`SELECT current_streak FROM loyalty_streaks WHERE user_id = ${userId}`,
  )) as unknown as { rows: { current_streak: number }[] };
  if (res.rows.length === 0) return null;
  return Number(res.rows[0]?.current_streak ?? 0);
}

function utcDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  const port = new DrizzleConsumerTransactionPort(db);
  const seedRepo = new DrizzleLoyaltyRepository(db);

  const users: string[] = [];
  const newUser = (): string => {
    const u = randomUUID();
    users.push(u);
    return u;
  };

  try {
    const present = (await exec(
      db,
      sql`SELECT to_regclass('event_outbox') IS NOT NULL AS a,
                 to_regclass('event_consumer_dedup') IS NOT NULL AS b,
                 to_regclass('loyalty_stamp_cards') IS NOT NULL AS c,
                 to_regclass('loyalty_wallets') IS NOT NULL AS d,
                 to_regclass('loyalty_streaks') IS NOT NULL AS e`,
    )) as unknown as {
      rows: { a: boolean; b: boolean; c: boolean; d: boolean; e: boolean }[];
    };
    const r0 = present.rows[0];
    check(
      r0?.a === true && r0?.b === true && r0?.c === true && r0?.d === true && r0?.e === true,
      "NP3A-PG-0 required tables present",
    );

    // =========================================================
    // NP3A-PG-ORDER-STAMP
    // =========================================================
    {
      const user = newUser();
      const rest = randomUUID();
      for (let i = 0; i < 9; i += 1) await seedRepo.incrementStamp(user, rest);
      const parent = randomUUID();
      let rewardUnlocked = false;
      let childId: string | null = null;

      const winner = await port.runInTransaction(async (scope: ConsumerTxScope) => {
        const won = await scope.claim(CONSUMER_ORDER_STAMP, parent);
        if (!won) return false;
        const res = await scope.loyalty.incrementStamp(user, rest);
        rewardUnlocked = res.reward_unlocked;
        if (res.reward_unlocked) {
          const env = createEventEnvelope("StampCardRewardUnlocked", user, {
            user_id: user,
            restaurant_id: rest,
            reward_type: "FREE_ITEM",
            stamp_count_before: 9,
            rewards_earned: res.card.rewards_earned,
          });
          await scope.outbox.enqueue(env);
          childId = env.event_id;
        }
        return true;
      });
      check(winner === true, "NP3A-PG-ORDER-STAMP winner applied");
      check(rewardUnlocked === true, "NP3A-PG-ORDER-STAMP reward predicate true at 10th stamp");
      check(childId !== null && childId !== parent, "NP3A-PG-ORDER-STAMP child has its OWN event_id");
      check((await markerCount(db, CONSUMER_ORDER_STAMP, parent)) === 1, "NP3A-PG-ORDER-STAMP marker committed");
      check((await stampRowCount(db, user)) === 1, "NP3A-PG-ORDER-STAMP stamp effect committed");
      check(childId !== null && (await outboxById(db, childId)) === 1, "NP3A-PG-ORDER-STAMP winner_exactly_one child row");

      const duplicate = await port.runInTransaction(async (scope: ConsumerTxScope) => {
        const won = await scope.claim(CONSUMER_ORDER_STAMP, parent);
        if (!won) return false;
        await scope.loyalty.incrementStamp(user, rest);
        await scope.outbox.enqueue(
          createEventEnvelope("StampCardRewardUnlocked", user, { duplicate: true }),
        );
        return true;
      });
      check(duplicate === false, "NP3A-PG-ORDER-STAMP duplicate lost the claim");
      check(
        (await childCount(db, "StampCardRewardUnlocked", user)) === 1,
        "NP3A-PG-ORDER-STAMP duplicate_zero_additional child rows",
      );

      const rbUser = newUser();
      const rbParent = randomUUID();
      let threw = false;
      try {
        await port.runInTransaction(async (scope: ConsumerTxScope) => {
          const won = await scope.claim(CONSUMER_ORDER_STAMP, rbParent);
          if (!won) return;
          await scope.loyalty.incrementStamp(rbUser, rest);
          await scope.outbox.enqueue(
            createEventEnvelope("StampCardRewardUnlocked", rbUser, { rollback: true }),
          );
          throw new Error("np3a-order-stamp-force-rollback");
        });
      } catch {
        threw = true;
      }
      check(threw, "NP3A-PG-ORDER-STAMP rollback propagated");
      check((await markerCount(db, CONSUMER_ORDER_STAMP, rbParent)) === 0, "NP3A-PG-ORDER-STAMP rollback marker == 0");
      check((await stampRowCount(db, rbUser)) === 0, "NP3A-PG-ORDER-STAMP rollback stamp effect == 0");
      check(
        (await childCount(db, "StampCardRewardUnlocked", rbUser)) === 0,
        "NP3A-PG-ORDER-STAMP rollback child rows == 0",
      );
    }

    // =========================================================
    // NP3A-PG-GIFT-STAMP
    // =========================================================
    {
      const sender = newUser();
      const rest = randomUUID();
      for (let i = 0; i < 9; i += 1) await seedRepo.incrementStamp(sender, rest);
      const parent = randomUUID();
      let childId: string | null = null;

      const winner = await port.runInTransaction(async (scope: ConsumerTxScope) => {
        const won = await scope.claim(CONSUMER_GIFT_STAMP, parent);
        if (!won) return false;
        const res = await scope.loyalty.incrementStamp(sender, rest);
        if (res.reward_unlocked) {
          const env = createEventEnvelope("StampCardRewardUnlocked", sender, {
            user_id: sender,
            restaurant_id: rest,
            reward_type: "FREE_ITEM",
            stamp_count_before: 9,
            rewards_earned: res.card.rewards_earned,
          });
          await scope.outbox.enqueue(env);
          childId = env.event_id;
        }
        return true;
      });
      check(winner === true, "NP3A-PG-GIFT-STAMP winner applied");
      check((await markerCount(db, CONSUMER_GIFT_STAMP, parent)) === 1, "NP3A-PG-GIFT-STAMP marker committed");
      check((await stampRowCount(db, sender)) === 1, "NP3A-PG-GIFT-STAMP stamp effect committed");
      check(childId !== null && (await outboxById(db, childId)) === 1, "NP3A-PG-GIFT-STAMP winner_exactly_one child row");

      const duplicate = await port.runInTransaction(async (scope: ConsumerTxScope) => {
        const won = await scope.claim(CONSUMER_GIFT_STAMP, parent);
        if (!won) return false;
        await scope.outbox.enqueue(
          createEventEnvelope("StampCardRewardUnlocked", sender, { duplicate: true }),
        );
        return true;
      });
      check(duplicate === false, "NP3A-PG-GIFT-STAMP duplicate lost the claim");
      check(
        (await childCount(db, "StampCardRewardUnlocked", sender)) === 1,
        "NP3A-PG-GIFT-STAMP duplicate_zero_additional child rows",
      );

      const rbSender = newUser();
      const rbParent = randomUUID();
      let threw = false;
      try {
        await port.runInTransaction(async (scope: ConsumerTxScope) => {
          const won = await scope.claim(CONSUMER_GIFT_STAMP, rbParent);
          if (!won) return;
          await scope.loyalty.incrementStamp(rbSender, rest);
          await scope.outbox.enqueue(
            createEventEnvelope("StampCardRewardUnlocked", rbSender, { rollback: true }),
          );
          throw new Error("np3a-gift-stamp-force-rollback");
        });
      } catch {
        threw = true;
      }
      check(threw, "NP3A-PG-GIFT-STAMP rollback propagated");
      check((await markerCount(db, CONSUMER_GIFT_STAMP, rbParent)) === 0, "NP3A-PG-GIFT-STAMP rollback marker == 0");
      check((await stampRowCount(db, rbSender)) === 0, "NP3A-PG-GIFT-STAMP rollback stamp effect == 0");
      check(
        (await childCount(db, "StampCardRewardUnlocked", rbSender)) === 0,
        "NP3A-PG-GIFT-STAMP rollback child rows == 0",
      );
    }

    // =========================================================
    // NP3A-PG-CASHBACK
    // =========================================================
    {
      const user = newUser();
      const parent = randomUUID();
      let childId: string | null = null;

      const winner = await port.runInTransaction(async (scope: ConsumerTxScope) => {
        const won = await scope.claim(CONSUMER_CASHBACK, parent);
        if (!won) return false;
        const wallet = await scope.loyalty.creditWallet(user, 5, "pickup_cashback");
        const env = createEventEnvelope("WalletCashbackCredited", user, {
          user_id: user,
          order_id: parent,
          amount: 5,
          balance_after: wallet.balance,
        });
        await scope.outbox.enqueue(env);
        childId = env.event_id;
        return true;
      });
      check(winner === true, "NP3A-PG-CASHBACK winner applied");
      check((await markerCount(db, CONSUMER_CASHBACK, parent)) === 1, "NP3A-PG-CASHBACK marker committed");
      check((await walletRowCount(db, user)) === 1, "NP3A-PG-CASHBACK wallet effect committed");
      check((await ledgerCount(db, user)) === 1, "NP3A-PG-CASHBACK ledger effect committed");
      check(childId !== null && childId !== parent, "NP3A-PG-CASHBACK child has its OWN event_id");
      check(childId !== null && (await outboxById(db, childId)) === 1, "NP3A-PG-CASHBACK winner_exactly_one child row");

      const duplicate = await port.runInTransaction(async (scope: ConsumerTxScope) => {
        const won = await scope.claim(CONSUMER_CASHBACK, parent);
        if (!won) return false;
        await scope.loyalty.creditWallet(user, 5, "pickup_cashback");
        await scope.outbox.enqueue(
          createEventEnvelope("WalletCashbackCredited", user, { duplicate: true }),
        );
        return true;
      });
      check(duplicate === false, "NP3A-PG-CASHBACK duplicate lost the claim");
      check((await ledgerCount(db, user)) === 1, "NP3A-PG-CASHBACK duplicate ledger NOT doubled");
      check(
        (await childCount(db, "WalletCashbackCredited", user)) === 1,
        "NP3A-PG-CASHBACK duplicate_zero_additional child rows",
      );

      const rbUser = newUser();
      const rbParent = randomUUID();
      let threw = false;
      try {
        await port.runInTransaction(async (scope: ConsumerTxScope) => {
          const won = await scope.claim(CONSUMER_CASHBACK, rbParent);
          if (!won) return;
          await scope.loyalty.creditWallet(rbUser, 5, "pickup_cashback");
          await scope.outbox.enqueue(
            createEventEnvelope("WalletCashbackCredited", rbUser, { rollback: true }),
          );
          throw new Error("np3a-cashback-force-rollback");
        });
      } catch {
        threw = true;
      }
      check(threw, "NP3A-PG-CASHBACK rollback propagated");
      check((await markerCount(db, CONSUMER_CASHBACK, rbParent)) === 0, "NP3A-PG-CASHBACK rollback marker == 0");
      check((await walletRowCount(db, rbUser)) === 0, "NP3A-PG-CASHBACK rollback wallet == 0");
      check((await ledgerCount(db, rbUser)) === 0, "NP3A-PG-CASHBACK rollback ledger == 0");
      check(
        (await childCount(db, "WalletCashbackCredited", rbUser)) === 0,
        "NP3A-PG-CASHBACK rollback child rows == 0",
      );
    }

    // =========================================================
    // NP3A-PG-STREAK
    // =========================================================
    {
      const user = newUser();
      for (let i = 6; i >= 1; i -= 1) await seedRepo.recordPickup(user, utcDay(i));
      const parent = randomUUID();
      let badgeUnlocked = false;
      let childId: string | null = null;

      const winner = await port.runInTransaction(async (scope: ConsumerTxScope) => {
        const won = await scope.claim(CONSUMER_STREAK, parent);
        if (!won) return false;
        const res = await scope.loyalty.recordPickup(user, utcDay(0));
        badgeUnlocked = res.badge_unlocked;
        if (res.badge_unlocked) {
          const env = createEventEnvelope("StreakBadgeUnlocked", user, {
            user_id: user,
            streak: res.streak.current_streak,
            coupon_code: `SNKZ-STREAK-${res.streak.current_streak}`,
            discount_rate: 0.1,
          });
          await scope.outbox.enqueue(env);
          childId = env.event_id;
        }
        return true;
      });
      check(winner === true, "NP3A-PG-STREAK winner applied");
      check(badgeUnlocked === true, "NP3A-PG-STREAK badge predicate true on 7th consecutive day");
      check((await markerCount(db, CONSUMER_STREAK, parent)) === 1, "NP3A-PG-STREAK marker committed");
      check((await streakCurrent(db, user)) === 7, "NP3A-PG-STREAK streak effect committed");
      check(childId !== null && childId !== parent, "NP3A-PG-STREAK child has its OWN event_id");
      check(childId !== null && (await outboxById(db, childId)) === 1, "NP3A-PG-STREAK winner_exactly_one child row");

      const duplicate = await port.runInTransaction(async (scope: ConsumerTxScope) => {
        const won = await scope.claim(CONSUMER_STREAK, parent);
        if (!won) return false;
        await scope.outbox.enqueue(
          createEventEnvelope("StreakBadgeUnlocked", user, { duplicate: true }),
        );
        return true;
      });
      check(duplicate === false, "NP3A-PG-STREAK duplicate lost the claim");
      check((await streakCurrent(db, user)) === 7, "NP3A-PG-STREAK duplicate did not advance further");
      check(
        (await childCount(db, "StreakBadgeUnlocked", user)) === 1,
        "NP3A-PG-STREAK duplicate_zero_additional child rows",
      );

      const rbUser = newUser();
      for (let i = 6; i >= 1; i -= 1) await seedRepo.recordPickup(rbUser, utcDay(i));
      const rbParent = randomUUID();
      let threw = false;
      try {
        await port.runInTransaction(async (scope: ConsumerTxScope) => {
          const won = await scope.claim(CONSUMER_STREAK, rbParent);
          if (!won) return;
          await scope.loyalty.recordPickup(rbUser, utcDay(0));
          await scope.outbox.enqueue(
            createEventEnvelope("StreakBadgeUnlocked", rbUser, { rollback: true }),
          );
          throw new Error("np3a-streak-force-rollback");
        });
      } catch {
        threw = true;
      }
      check(threw, "NP3A-PG-STREAK rollback propagated");
      check((await markerCount(db, CONSUMER_STREAK, rbParent)) === 0, "NP3A-PG-STREAK rollback marker == 0");
      check((await streakCurrent(db, rbUser)) === 6, "NP3A-PG-STREAK rollback streak effect == 6 (unchanged)");
      check(
        (await childCount(db, "StreakBadgeUnlocked", rbUser)) === 0,
        "NP3A-PG-STREAK rollback child rows == 0",
      );
    }
  } finally {
    await exec(
      db,
      sql`DELETE FROM event_consumer_dedup WHERE consumer_name LIKE ${PREFIX + "%"}`,
    );
    for (const u of users) {
      await exec(db, sql`DELETE FROM event_outbox WHERE aggregate_id = ${u}`);
      await exec(db, sql`DELETE FROM loyalty_stamp_cards WHERE user_id = ${u}`);
      await exec(db, sql`DELETE FROM loyalty_ledger WHERE user_id = ${u}`);
      await exec(db, sql`DELETE FROM loyalty_wallets WHERE user_id = ${u}`);
      await exec(db, sql`DELETE FROM loyalty_streaks WHERE user_id = ${u}`);
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`RESULT: FAIL (${failures} failed)`);
    process.exit(1);
  }
  console.log("RESULT: PASS (all NP3-A real-PG nested atomicity checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
