// ============================================================
// EVT-B2B-PAY-B3 (G1) — Real PostgreSQL proof that the gift mock-refund local
// tail (payment -> REFUNDED + the gift markRefunded CAS + the GiftRefunded
// outbox row) commits as ONE transaction, that the refund RESERVATION is
// committed BEFORE the provider call, and that the provider call stays OUTSIDE
// the transaction (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with a disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<fresh migrated DB> \
//   pnpm exec tsx apps/api/integration/realPgB2bPayBGiftRefund.ts
//
// The target DB is created fresh and fully migrated with
// `pnpm --filter @snakzap/db exec drizzle-kit migrate` (all 28 migrations).
//
// SCOPE NOTE (truthful limitation): this harness drives the REAL
// submitGiftRefund() over the REAL DrizzlePaymentTransactionPort (tx-scoped
// repositories + real DrizzleEventOutboxRepository on the same `tx`). The
// outbox is NOT mocked. The Razorpay provider is a deterministic OFFLINE double
// installed on the razorpayService singleton that, at call time, reads the gift
// row to prove the reservation was committed before the provider ran. A probe
// port proves the provider is never invoked inside a transaction. The
// forced-rollback case runs the real transaction and throws after the tail has
// enqueued, proving the outbox row, the payment update and the gift CAS all
// roll back together while the reservation lifecycle (committed outside the
// transaction) is left in a retryable state.
//
// Proves against real PostgreSQL:
//   success          -> gift REFUNDED + payment REFUNDED + exactly one durable
//                       GiftRefunded child row (keyed by gift_id)
//   reservation      -> gift is REFUNDING with refund_requested_at set at the
//                       moment the provider is called
//   duplicate        -> no additional child rows
//   CAS loser        -> zero rows, provider never called
//   forced rollback  -> zero child rows AND payment/gift-tail reverted
//   provider boundary-> provider exercised, zero provider calls inside a tx
//
// Memory mode cannot prove transactional atomicity
// (MEMORY_ATOMICITY_GUARANTEE = NONE).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type {
  PaymentTransactionPort,
  PaymentTxRepos,
} from "../src/repositories/paymentAtomicityContracts";
import { DrizzlePaymentTransactionPort } from "../src/repositories/drizzle/paymentTransactionPort";
import { DrizzlePaymentRepository } from "../src/repositories/drizzle/drizzlePaymentRepository";
import { DrizzleGiftRepository } from "../src/repositories/drizzle/drizzleGiftRepository";
import { razorpayService } from "../src/services/razorpay";
import { submitGiftRefund } from "../src/services/gift";

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

const PREFIX = "pay-b3-";

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

async function countByAgg(db: DrizzleDb, eventName: string, aggregateId: string): Promise<number> {
  const res = (await exec(
    db,
    sql`SELECT count(*)::text AS n FROM event_outbox
        WHERE event_name = ${eventName} AND aggregate_id = ${aggregateId}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

async function eventIdFor(db: DrizzleDb, eventName: string, aggregateId: string): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT event_id FROM event_outbox
        WHERE event_name = ${eventName} AND aggregate_id = ${aggregateId}`,
  )) as unknown as { rows: { event_id: string }[] };
  return res.rows[0]?.event_id ?? null;
}

async function giftRow(
  db: DrizzleDb,
  giftId: string,
): Promise<{ status: string; refund_requested_at: string | null } | null> {
  const res = (await exec(
    db,
    sql`SELECT status, refund_requested_at::text AS r FROM gifts WHERE id = ${giftId}`,
  )) as unknown as { rows: { status: string; r: string | null }[] };
  const row = res.rows[0];
  return row ? { status: row.status, refund_requested_at: row.r } : null;
}

async function paymentStatus(db: DrizzleDb, paymentId: string): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT status FROM payments WHERE id = ${paymentId}`,
  )) as unknown as { rows: { status: string }[] };
  return res.rows[0]?.status ?? null;
}

/**
 * Tracks whether a transaction is open and whether the provider double was ever
 * invoked while one was. This is the external-call-outside-tx probe.
 */
class TxProbe {
  inTx = false;
  providerCalls = 0;
  providerCallsInTx = 0;
  reservationSeenAtProvider: boolean | null = null;
  statusAtProvider: string | null = null;
}

class ProbePort implements PaymentTransactionPort {
  constructor(
    private readonly inner: PaymentTransactionPort,
    private readonly probe: TxProbe,
  ) {}

  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      this.probe.inTx = true;
      try {
        return await fn(repos);
      } finally {
        this.probe.inTx = false;
      }
    });
  }
}

/** Test-only wrapper: runs the real tx, then throws before commit so the whole
 *  transaction (payment update + gift CAS + outbox row) rolls back. */
class RollbackAfterPort implements PaymentTransactionPort {
  constructor(private readonly inner: PaymentTransactionPort) {}

  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      await fn(repos);
      throw new Error("pay-b3-force-rollback");
    });
  }
}

interface World {
  userId: string;
  restaurantId: string;
  menuItemId: string;
}

interface Created {
  users: string[];
  restaurants: string[];
  menuItems: string[];
  gifts: string[];
}

async function seedWorld(db: DrizzleDb, created: Created): Promise<World> {
  const userId = randomUUID();
  const restaurantId = randomUUID();
  const menuItemId = randomUUID();
  created.users.push(userId);
  created.restaurants.push(restaurantId);
  created.menuItems.push(menuItemId);

  await exec(
    db,
    sql`INSERT INTO users (id, phone) VALUES (${userId}, ${`${PREFIX}${randomUUID()}`})`,
  );
  await exec(
    db,
    sql`INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
        VALUES (${restaurantId}, ${userId}, ${`PAYB3-R-${randomUUID().slice(0, 8)}`},
                ${`GST${randomUUID().replace(/-/g, "").slice(0, 12)}`},
                ${`FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`}, true)`,
  );
  await exec(
    db,
    sql`INSERT INTO menu_items (id, restaurant_id, name, price)
        VALUES (${menuItemId}, ${restaurantId}, ${`PAYB3-ITEM-${randomUUID().slice(0, 8)}`}, 30)`,
  );
  return { userId, restaurantId, menuItemId };
}

async function seedGift(
  db: DrizzleDb,
  w: World,
  created: Created,
  status: string,
  refundRequestedAt: boolean,
): Promise<string> {
  const giftId = randomUUID();
  created.gifts.push(giftId);
  const snapshot = {
    name: "Samosa",
    price: 30,
    image_url: null,
    dietary_tags: {},
    spice_level: 1,
    customizations: [],
  };
  await exec(
    db,
    sql`INSERT INTO gifts
          (id, sender_id, restaurant_id, menu_item_id, item_snapshot, price_paid,
           claim_token, claim_code, status, refund_requested_at, expires_at)
        VALUES (${giftId}, ${w.userId}, ${w.restaurantId}, ${w.menuItemId},
                ${JSON.stringify(snapshot)}::jsonb, 30,
                ${`tok-${randomUUID()}`}, ${`CC${randomUUID().slice(0, 8).toUpperCase()}`},
                ${status}, ${refundRequestedAt ? sql`now()` : sql`NULL`},
                now() + interval '90 days')`,
  );
  const paymentId = randomUUID();
  const metadata = { currency: "INR", razorpay_payment_id: `pay_${giftId.slice(0, 8)}` };
  await exec(
    db,
    sql`INSERT INTO payments
          (id, gift_id, provider_transaction_id, amount, status, metadata)
        VALUES (${paymentId}, ${giftId}, ${`order_${giftId.slice(0, 8)}`}, 30, 'CAPTURED',
                ${JSON.stringify(metadata)}::jsonb)`,
  );
  return giftId;
}

async function paymentIdForGift(db: DrizzleDb, giftId: string): Promise<string> {
  const res = (await exec(
    db,
    sql`SELECT id FROM payments WHERE gift_id = ${giftId}`,
  )) as unknown as { rows: { id: string }[] };
  return res.rows[0]!.id;
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 6 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  const paymentRepo = new DrizzlePaymentRepository(db);
  const giftRepo = new DrizzleGiftRepository(db);

  const probe = new TxProbe();
  const realPort = new DrizzlePaymentTransactionPort(db);
  const successPort = new ProbePort(realPort, probe);
  const rollbackPort = new ProbePort(new RollbackAfterPort(realPort), probe);

  // Deterministic offline provider double: records the external-call boundary
  // and snaps the gift row at call time to prove the reservation was committed
  // before the provider ran.
  let activeGiftId: string | null = null;
  const originalRefund = razorpayService.refund.bind(razorpayService);
  razorpayService.refund = async (paymentId: string, amountInPaise: number) => {
    probe.providerCalls += 1;
    if (probe.inTx) probe.providerCallsInTx += 1;
    if (activeGiftId) {
      const row = await giftRow(db, activeGiftId);
      probe.statusAtProvider = row?.status ?? null;
      probe.reservationSeenAtProvider = row?.refund_requested_at != null;
    }
    void paymentId;
    void amountInPaise;
    return { id: `refund_mock_payb3_${randomUUID().slice(0, 8)}`, status: "processed" };
  };

  const created: Created = { users: [], restaurants: [], menuItems: [], gifts: [] };

  try {
    const present = (await exec(
      db,
      sql`SELECT to_regclass('event_outbox') IS NOT NULL AS a,
                 to_regclass('payments') IS NOT NULL AS b,
                 to_regclass('gifts') IS NOT NULL AS c,
                 to_regclass('users') IS NOT NULL AS d,
                 to_regclass('restaurants') IS NOT NULL AS e,
                 to_regclass('menu_items') IS NOT NULL AS f`,
    )) as unknown as {
      rows: { a: boolean; b: boolean; c: boolean; d: boolean; e: boolean; f: boolean }[];
    };
    const r0 = present.rows[0];
    check(
      r0?.a === true &&
        r0?.b === true &&
        r0?.c === true &&
        r0?.d === true &&
        r0?.e === true &&
        r0?.f === true,
      "PAYB3-PG-0 required tables present",
    );

    // =========================================================
    // G1-PG-1: success + duplicate + reservation-before-provider
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const giftId = await seedGift(db, w, created, "ACTIVE", false);
      activeGiftId = giftId;
      const gift = (await giftRepo.getById(giftId))!;

      const result = await submitGiftRefund(gift, giftRepo, paymentRepo, ["ACTIVE"], successPort);

      check(result.status === "REFUNDED", "PAYB3-PG-1 result REFUNDED");
      const after = (await giftRow(db, giftId))!;
      check(after.status === "REFUNDED", "PAYB3-PG-1 gift REFUNDED");
      check(after.refund_requested_at !== null, "PAYB3-PG-1 gift reservation retained");
      const paymentId = await paymentIdForGift(db, giftId);
      check((await paymentStatus(db, paymentId)) === "REFUNDED", "PAYB3-PG-1 payment REFUNDED");
      check(
        (await countByAgg(db, "GiftRefunded", giftId)) === 1,
        "PAYB3-PG-1 success_exactly_one child row",
      );
      check(
        (await eventIdFor(db, "GiftRefunded", giftId)) !== null,
        "PAYB3-PG-1 durable event_id present",
      );
      check(
        probe.statusAtProvider === "REFUNDING" && probe.reservationSeenAtProvider === true,
        "PAYB3-PG-1 reservation committed before provider call",
      );

      const dup = await submitGiftRefund(
        (await giftRepo.getById(giftId))!,
        giftRepo,
        paymentRepo,
        ["ACTIVE"],
        successPort,
      );
      check(dup.status === "REFUNDED", "PAYB3-PG-1 duplicate returns REFUNDED");
      check(
        (await countByAgg(db, "GiftRefunded", giftId)) === 1,
        "PAYB3-PG-1 duplicate_zero additional child rows",
      );
    }

    // =========================================================
    // G1-PG-2: reservation CAS loser (gift no longer ACTIVE)
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const giftId = await seedGift(db, w, created, "ACTIVE", false);
      activeGiftId = giftId;
      const staleActive = (await giftRepo.getById(giftId))!;
      await exec(db, sql`UPDATE gifts SET status = 'CLAIMED' WHERE id = ${giftId}`);
      const before = probe.providerCalls;

      const result = await submitGiftRefund(staleActive, giftRepo, paymentRepo, ["ACTIVE"], successPort);

      check(result.status === "CLAIMED", "PAYB3-PG-2 result CLAIMED");
      check(
        (await countByAgg(db, "GiftRefunded", giftId)) === 0,
        "PAYB3-PG-2 zero child rows",
      );
      check(probe.providerCalls === before, "PAYB3-PG-2 provider never called");
      const after = (await giftRow(db, giftId))!;
      check(after.status === "CLAIMED", "PAYB3-PG-2 gift unchanged");
      check(after.refund_requested_at === null, "PAYB3-PG-2 reservation not taken");
    }

    // =========================================================
    // G1-PG-3: forced rollback after the tail has run
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const giftId = await seedGift(db, w, created, "ACTIVE", false);
      activeGiftId = giftId;
      const gift = (await giftRepo.getById(giftId))!;

      const result = await submitGiftRefund(gift, giftRepo, paymentRepo, ["ACTIVE"], rollbackPort);
      // The service swallows a local-tail failure, rolls the transaction back
      // and clears the reservation so a later sweep can retry.
      check(result.status === "REFUNDING", "PAYB3-PG-3 rollback surfaced as REFUNDING");
      check(
        (await countByAgg(db, "GiftRefunded", giftId)) === 0,
        "PAYB3-PG-3 rollback child rows == 0",
      );
      const paymentId = await paymentIdForGift(db, giftId);
      check(
        (await paymentStatus(db, paymentId)) === "CAPTURED",
        "PAYB3-PG-3 rollback payment reverted",
      );
      const after = (await giftRow(db, giftId))!;
      check(after.status === "REFUNDING", "PAYB3-PG-3 rollback gift tail reverted");
      check(after.refund_requested_at === null, "PAYB3-PG-3 reservation cleared for retry");
    }

    // =========================================================
    // External-call-outside-tx probe
    // =========================================================
    check(probe.providerCalls > 0, "PAYB3-PG-PROBE provider exercised");
    check(
      probe.providerCallsInTx === 0,
      "PAYB3-PG-PROBE zero provider calls inside a transaction",
    );
  } finally {
    razorpayService.refund = originalRefund;
    for (const giftId of created.gifts) {
      await pool.query(`DELETE FROM payments WHERE gift_id = $1`, [giftId]);
      await pool.query(`DELETE FROM gifts WHERE id = $1`, [giftId]);
    }
    for (const menuItemId of created.menuItems) {
      await pool.query(`DELETE FROM menu_items WHERE id = $1`, [menuItemId]);
    }
    for (const restaurantId of created.restaurants) {
      await pool.query(`DELETE FROM restaurants WHERE id = $1`, [restaurantId]);
    }
    for (const userId of created.users) {
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    if (created.gifts.length > 0) {
      await pool.query(`DELETE FROM event_outbox WHERE aggregate_id = ANY($1::text[])`, [
        created.gifts,
      ]);
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`RESULT: FAIL (${failures} failed)`);
    process.exit(1);
  }
  console.log("RESULT: PASS (all PAY-B3 G1 real-PG gift-refund atomicity checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
