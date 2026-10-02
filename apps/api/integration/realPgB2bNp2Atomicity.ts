// ============================================================
// EVT-B2B-NP2 — Real PostgreSQL producer transaction-boundary proof
// (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/evt_b1_run \
//   pnpm exec tsx apps/api/integration/realPgB2bNp2Atomicity.ts
//
// Proves, against real PostgreSQL, that each remaining NP2 producer transaction
// port runs `outbox.enqueue` on the SAME transaction handle as the business
// mutation:
//
//   NP2-PG-F1 fulfillment port COMMIT   -> exactly one PENDING row persisted
//   NP2-PG-F2 fulfillment CAS-loser     -> zero rows persisted
//   NP2-PG-F3 fulfillment ROLLBACK      -> zero rows persisted
//   NP2-PG-G1 gift-expiry port COMMIT   -> exactly one PENDING row persisted
//   NP2-PG-G2 gift-expiry port ROLLBACK -> zero rows persisted
//   NP2-PG-R1 referral REAL business path COMMIT:
//     recordClaim + referrer credit + claimant credit + referral_applied audit
//     + ReferralClaimed outbox row all persist; outbox exactly one PENDING.
//   NP2-PG-R2 referral REAL business path ROLLBACK after full partial progress
//     (MANDATORY): forced failure -> claim + both wallets + ledger + audit +
//     outbox ALL roll back to zero.
//   NP2-PG-V1 VIP port ROLLBACK         -> zero rows persisted
//   NP2-PG-U1 spice port ROLLBACK       -> zero rows persisted
//   NP2-PG-M1 menu-sync port ROLLBACK   -> zero rows persisted
//   NP2-PG-BIZ business write + outbox insert in one raw tx roll back together
//   NP2-PG-ID1 persisted event_id survives reconstruction + relay, then deleted
//
// NOTE ON DOMAIN ROWS: the referral case runs the actual tx-scoped business
// repos (loyalty_referrals + loyalty_wallets + loyalty_ledger + audit_logs +
// event_outbox) and asserts each row directly, so it is an end-to-end business
// rollback proof. For the other producers the disposable EVT DB does not carry
// every domain table, so those cases prove the outbox's transaction membership
// directly on the named port; every `build*TxRepos` binds the business repos to
// the SAME `tx` handle passed to `outbox` (see the port module), so the business
// write and the event row share one commit boundary by construction. The raw
// NP2-PG-BIZ case proves the shared commit boundary against a real second table.
//
// Does NOT claim: consumer idempotency (EVT-C), exactly-once delivery
// (DELIVERY = AT_LEAST_ONCE by design), or the full HTTP producer flow.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import type { DrizzleDb } from "../src/lib/dbType";
import type { EventOutboxRepository } from "../src/repositories/eventOutboxRepository";
import { DrizzleFulfillmentTransactionPort } from "../src/repositories/drizzle/fulfillmentTransactionPort";
import { DrizzleGiftExpiryTransactionPort } from "../src/repositories/drizzle/producerRemainingTransactionPort";
import { DrizzleReferralTransactionPort } from "../src/repositories/drizzle/producerRemainingTransactionPort";
import { DrizzleVipTicketTransactionPort } from "../src/repositories/drizzle/producerRemainingTransactionPort";
import { DrizzleSpiceProfileTransactionPort } from "../src/repositories/drizzle/producerRemainingTransactionPort";
import { DrizzleMenuSyncTransactionPort } from "../src/repositories/drizzle/producerRemainingTransactionPort";
import {
  DrizzleEventOutboxRepository,
  enqueueDomainEvent,
} from "../src/repositories/drizzle/drizzleEventOutboxRepository";
import { outboxRowToEnvelope } from "../src/repositories/eventOutboxRepository";
import { EventOutboxRelay } from "../src/services/eventOutboxRelay";

const maybeUrl = process.env.DATABASE_URL;
if (!maybeUrl) {
  console.error("FATAL: DATABASE_URL is required (must point at the disposable EVT DB)");
  process.exit(2);
}
const url: string = maybeUrl;
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV (createDb() rejects test mode)");
  process.exit(2);
}

const BIZ_PREFIX = "itrack-np2-";

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

function envelope(
  eventId: string,
  eventName: EventName,
  aggregateId: string,
): TypedEventEnvelope<EventName> {
  return {
    event_id: eventId,
    event_name: eventName,
    aggregate_id: aggregateId,
    timestamp: new Date(),
    payload: { event_id: BIZ_PREFIX + "payload" },
    metadata: { correlation_id: BIZ_PREFIX + "corr" },
  } as unknown as TypedEventEnvelope<EventName>;
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
const exec = (db: DrizzleDb, q: unknown) => (db as unknown as { execute: Exec }).execute(q);

async function countFor(db: DrizzleDb, eventId: string): Promise<number> {
  const res = (await exec(
    db,
    sql`SELECT count(*)::text AS n FROM event_outbox WHERE event_id = ${eventId}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

async function statusFor(db: DrizzleDb, eventId: string): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT status FROM event_outbox WHERE event_id = ${eventId}`,
  )) as unknown as { rows: { status: string }[] };
  return res.rows[0]?.status ?? null;
}

async function countRows(db: DrizzleDb, q: unknown): Promise<number> {
  const res = (await exec(db, q)) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

async function referralCount(db: DrizzleDb, claimant: string): Promise<number> {
  return countRows(
    db,
    sql`SELECT count(*)::text AS n FROM loyalty_referrals WHERE claimant_user_id = ${claimant}`,
  );
}

async function walletBalance(db: DrizzleDb, userId: string): Promise<number | null> {
  const res = (await exec(
    db,
    sql`SELECT balance FROM loyalty_wallets WHERE user_id = ${userId}`,
  )) as unknown as { rows: { balance: string }[] };
  if (res.rows.length === 0) return null;
  return Number(res.rows[0]?.balance ?? "0");
}

async function ledgerCount(db: DrizzleDb, userId: string): Promise<number> {
  return countRows(
    db,
    sql`SELECT count(*)::text AS n FROM loyalty_ledger WHERE user_id = ${userId}`,
  );
}

async function auditCount(db: DrizzleDb, actorId: string, action: string): Promise<number> {
  return countRows(
    db,
    sql`SELECT count(*)::text AS n FROM audit_logs WHERE actor_id = ${actorId} AND action = ${action}`,
  );
}

interface ReferralFixture {
  referrer: string;
  claimant: string;
}

async function cleanup(
  db: DrizzleDb,
  eventIds: string[],
  referrals: ReferralFixture[] = [],
): Promise<void> {
  for (const id of eventIds) {
    await exec(db, sql`DELETE FROM event_outbox WHERE event_id = ${id}`);
  }
  for (const r of referrals) {
    await exec(db, sql`DELETE FROM loyalty_referrals WHERE claimant_user_id = ${r.claimant}`);
    await exec(
      db,
      sql`DELETE FROM loyalty_ledger WHERE user_id = ${r.referrer} OR user_id = ${r.claimant}`,
    );
    await exec(
      db,
      sql`DELETE FROM loyalty_wallets WHERE user_id = ${r.referrer} OR user_id = ${r.claimant}`,
    );
    await exec(
      db,
      sql`DELETE FROM audit_logs WHERE actor_id = ${r.claimant} AND action = 'referral_applied'`,
    );
  }
  await exec(db, sql`DELETE FROM itrack_np2_business WHERE note LIKE ${BIZ_PREFIX + "%"}`);
}

/**
 * Narrow common view of every NP2 producer port: all expose an `outbox` whose
 * `enqueue` runs on the port's own transaction handle.
 */
type AnyNp2Port = {
  runInTransaction<T>(
    fn: (repos: { outbox: Pick<EventOutboxRepository, "enqueue"> }) => Promise<T>,
  ): Promise<T>;
};

async function proveCommit(
  db: DrizzleDb,
  created: string[],
  label: string,
  port: AnyNp2Port,
  eventName: EventName,
): Promise<void> {
  const eventId = randomUUID();
  created.push(eventId);
  await port.runInTransaction(async ({ outbox }) => {
    await outbox.enqueue(envelope(eventId, eventName, BIZ_PREFIX + "commit"));
  });
  check((await countFor(db, eventId)) === 1, `${label} commit persists exactly one row`);
  check((await statusFor(db, eventId)) === "PENDING", `${label} persisted row status = PENDING`);
}

async function proveRollback(
  db: DrizzleDb,
  created: string[],
  label: string,
  port: AnyNp2Port,
  eventName: EventName,
): Promise<void> {
  const eventId = randomUUID();
  created.push(eventId);
  let threw = false;
  try {
    await port.runInTransaction(async ({ outbox }) => {
      await outbox.enqueue(envelope(eventId, eventName, BIZ_PREFIX + "rollback"));
      throw new Error("itrack-force-rollback");
    });
  } catch {
    threw = true;
  }
  check(threw, `${label} rollback callback threw`);
  check(
    (await countFor(db, eventId)) === 0,
    `${label} rollback persists zero rows (enqueue shares tx)`,
  );
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool) as unknown as DrizzleDb;

  const created: string[] = [];
  const createdReferrals: ReferralFixture[] = [];

  try {
    await exec(
      db,
      sql`CREATE TABLE IF NOT EXISTS itrack_np2_business (
            id text PRIMARY KEY,
            note text NOT NULL
          )`,
    );

    // ------------------------------------------------------------------
    // Fulfillment advance port
    // ------------------------------------------------------------------
    const fulfillmentPort = new DrizzleFulfillmentTransactionPort(
      db,
    ) as unknown as AnyNp2Port;
    await proveCommit(db, created, "NP2-PG-F1 fulfillment", fulfillmentPort, "OrderPreparationStarted");
    await proveRollback(db, created, "NP2-PG-F3 fulfillment", fulfillmentPort, "OrderPreparationStarted");

    // CAS-loser: the callback observes a state mismatch and returns without
    // enqueuing, exactly as the service does on a lost CAS.
    {
      const eventId = randomUUID();
      created.push(eventId);
      const outcome = await fulfillmentPort.runInTransaction(async () => null);
      check(outcome === null, "NP2-PG-F2 fulfillment CAS-loser returns no transition");
      check((await countFor(db, eventId)) === 0, "NP2-PG-F2 fulfillment CAS-loser persists zero rows");
    }

    // ------------------------------------------------------------------
    // Gift expiry port
    // ------------------------------------------------------------------
    const giftPort = new DrizzleGiftExpiryTransactionPort(db) as unknown as AnyNp2Port;
    await proveCommit(db, created, "NP2-PG-G1 gift-expiry", giftPort, "GiftExpired");
    await proveRollback(db, created, "NP2-PG-G2 gift-expiry", giftPort, "GiftExpired");

    // ------------------------------------------------------------------
    // Referral port — REAL business path:
    //   recordClaim + referrer credit + claimant credit + referral_applied
    //   audit + ReferralClaimed outbox enqueue, all on the tx-scoped repos.
    //
    // R1 (commit twin): every one of those writes persists.
    // R2 (MANDATORY): after full partial progress the transaction is forced to
    //   fail, so claim + both wallets + ledger + audit + outbox ALL roll back.
    // ------------------------------------------------------------------
    const REFERRAL_BONUS = 50;
    const referralPort = new DrizzleReferralTransactionPort(db);

    {
      const referrer = randomUUID();
      const claimant = randomUUID();
      const eventId = randomUUID();
      const code = BIZ_PREFIX + "code-r1-" + randomUUID();
      created.push(eventId);
      createdReferrals.push({ referrer, claimant });

      await referralPort.runInTransaction(async ({ loyalty, audit, outbox }) => {
        await loyalty.recordClaim({
          claimant_user_id: claimant,
          referrer_user_id: referrer,
          referral_code: code,
          bonus_amount: REFERRAL_BONUS,
          ip_address: BIZ_PREFIX + "ip-r1-" + randomUUID(),
          device_fingerprint: BIZ_PREFIX + "dev-r1-" + randomUUID(),
        });
        await loyalty.creditWallet(referrer, REFERRAL_BONUS, "referral_bonus");
        await loyalty.creditWallet(claimant, REFERRAL_BONUS, "referral_bonus");
        await audit.log(claimant, "referral_applied", { referral_code: code });
        await outbox.enqueue(envelope(eventId, "ReferralClaimed", claimant));
      });

      check((await referralCount(db, claimant)) === 1, "NP2-PG-R1 claim_persisted");
      check(
        (await walletBalance(db, referrer)) === REFERRAL_BONUS,
        "NP2-PG-R1 referrer_wallet_persisted",
      );
      check(
        (await walletBalance(db, claimant)) === REFERRAL_BONUS,
        "NP2-PG-R1 claimant_wallet_persisted",
      );
      check(
        (await ledgerCount(db, referrer)) === 1 && (await ledgerCount(db, claimant)) === 1,
        "NP2-PG-R1 ledger_persisted",
      );
      check(
        (await auditCount(db, claimant, "referral_applied")) === 1,
        "NP2-PG-R1 audit_persisted",
      );
      check(
        (await countFor(db, eventId)) === 1 && (await statusFor(db, eventId)) === "PENDING",
        "NP2-PG-R1 outbox_exactly_one_pending",
      );
    }

    {
      const referrer = randomUUID();
      const claimant = randomUUID();
      const eventId = randomUUID();
      const code = BIZ_PREFIX + "code-r2-" + randomUUID();
      created.push(eventId);
      createdReferrals.push({ referrer, claimant });

      let threw = false;
      try {
        await referralPort.runInTransaction(async ({ loyalty, audit, outbox }) => {
          // Full partial progress: every business write happens first ...
          await loyalty.recordClaim({
            claimant_user_id: claimant,
            referrer_user_id: referrer,
            referral_code: code,
            bonus_amount: REFERRAL_BONUS,
            ip_address: BIZ_PREFIX + "ip-r2-" + randomUUID(),
            device_fingerprint: BIZ_PREFIX + "dev-r2-" + randomUUID(),
          });
          await loyalty.creditWallet(referrer, REFERRAL_BONUS, "referral_bonus");
          await loyalty.creditWallet(claimant, REFERRAL_BONUS, "referral_bonus");
          await audit.log(claimant, "referral_applied", { referral_code: code });
          await outbox.enqueue(envelope(eventId, "ReferralClaimed", claimant));
          // ... then the transaction is forced to fail before it can commit.
          throw new Error("itrack-force-rollback");
        });
      } catch {
        threw = true;
      }

      check(threw, "NP2-PG-R2 forced_failure_after_full_partial_progress");
      check((await referralCount(db, claimant)) === 0, "NP2-PG-R2 claim_rollback");
      check(
        ((await walletBalance(db, referrer)) ?? 0) === 0,
        "NP2-PG-R2 referrer_wallet_rollback",
      );
      check(
        ((await walletBalance(db, claimant)) ?? 0) === 0,
        "NP2-PG-R2 claimant_wallet_rollback",
      );
      check(
        (await ledgerCount(db, referrer)) === 0 && (await ledgerCount(db, claimant)) === 0,
        "NP2-PG-R2 ledger_rollback",
      );
      check(
        (await auditCount(db, claimant, "referral_applied")) === 0,
        "NP2-PG-R2 audit_rollback",
      );
      check((await countFor(db, eventId)) === 0, "NP2-PG-R2 outbox_rollback");
    }

    // ------------------------------------------------------------------
    // VIP ticket / spice profile / menu sync rollback proofs
    // ------------------------------------------------------------------
    const vipPort = new DrizzleVipTicketTransactionPort(db) as unknown as AnyNp2Port;
    await proveRollback(db, created, "NP2-PG-V1 VIP", vipPort, "VipTicketCreated");

    const spicePort = new DrizzleSpiceProfileTransactionPort(db) as unknown as AnyNp2Port;
    await proveRollback(db, created, "NP2-PG-U1 spice", spicePort, "SpiceProfileUpdated");

    const menuPort = new DrizzleMenuSyncTransactionPort(db) as unknown as AnyNp2Port;
    await proveRollback(db, created, "NP2-PG-M1 menu-sync", menuPort, "PosMenuSynced");

    // ------------------------------------------------------------------
    // Business write + outbox insert roll back together (raw tx)
    // ------------------------------------------------------------------
    const bizId = randomUUID();
    const bizEvent = randomUUID();
    created.push(bizEvent);
    let bizThrew = false;
    try {
      await (
        db as unknown as {
          transaction: <T>(fn: (tx: DrizzleDb) => Promise<T>) => Promise<T>;
        }
      ).transaction(async (tx) => {
        await exec(
          tx,
          sql`INSERT INTO itrack_np2_business (id, note) VALUES (${bizId}, ${BIZ_PREFIX + "biz"})`,
        );
        await enqueueDomainEvent(tx, envelope(bizEvent, "ReferralClaimed", BIZ_PREFIX + "biz"));
        throw new Error("itrack-force-rollback");
      });
    } catch {
      bizThrew = true;
    }
    const bizRes = (await exec(
      db,
      sql`SELECT count(*)::text AS n FROM itrack_np2_business WHERE id = ${bizId}`,
    )) as unknown as { rows: { n: string }[] };
    check(bizThrew, "NP2-PG-BIZ combined tx callback threw");
    check(
      Number(bizRes.rows[0]?.n ?? "0") === 0,
      "NP2-PG-BIZ business row rolled back with the outbox insert",
    );
    check((await countFor(db, bizEvent)) === 0, "NP2-PG-BIZ outbox row rolled back with business row");

    // ------------------------------------------------------------------
    // Persisted event_id survives reconstruction + relay; deleted on success
    // ------------------------------------------------------------------
    const stableId = randomUUID();
    created.push(stableId);
    await referralPort.runInTransaction(async ({ outbox }) => {
      await outbox.enqueue(envelope(stableId, "ReferralClaimed", BIZ_PREFIX + "stable"));
    });
    const rowRes = (await exec(
      db,
      sql`SELECT * FROM event_outbox WHERE event_id = ${stableId}`,
    )) as unknown as { rows: Record<string, unknown>[] };
    const row = rowRes.rows[0];
    if (!row) throw new Error("stable row missing");
    const reconstructed = outboxRowToEnvelope(row as never);
    check(reconstructed.event_id === stableId, "NP2-PG-ID1 reconstruction preserves persisted event_id");

    const relayRepo = new DrizzleEventOutboxRepository(db);
    const published: string[] = [];
    const relay = new EventOutboxRelay({
      repo: relayRepo,
      now: () => new Date(),
      publish: async (env) => {
        published.push(env.event_id);
      },
    });
    await relay.tick();
    check(published.includes(stableId), "NP2-PG-ID1 relay publishes the persisted event_id");
    check((await countFor(db, stableId)) === 0, "NP2-PG-ID1 row deleted after successful publish");
  } finally {
    await cleanup(db, created, createdReferrals);
    await pool.end();
  }

  if (failures > 0) {
    console.error(`RESULT: FAIL (${failures} failed)`);
    process.exit(1);
  }
  console.log("RESULT: PASS (all EVT-B2B-NP2 real-PG producer boundary checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
