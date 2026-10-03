// ============================================================
// EVT-B2B-PAY-B2 M1 — Real PostgreSQL proof that the operator manual-review
// RECOVER_TO_CONFIRMED local tail (order CAS -> CONFIRMED + PaymentSucceeded
// outbox row + reconciliation-result marker) commits as ONE transaction and
// that the gateway integrity read stays OUTSIDE it (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with a disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<fresh migrated DB> \
//   pnpm exec tsx apps/api/integration/realPgB2bPayBManualReview.ts
//
// The target DB is created fresh and fully migrated with
// `pnpm --filter @snakzap/db exec drizzle-kit migrate` (all 28 migrations).
//
// SCOPE NOTE (truthful limitation): this harness drives the REAL
// PaymentManualReviewService over the REAL DrizzlePaymentTransactionPort
// (tx-scoped repositories + real DrizzleEventOutboxRepository on the same `tx`)
// and a deterministic OFFLINE gateway double. The outbox is NOT mocked. Gateway
// reads are proven to happen OUTSIDE the transaction via a probe port. The
// forced-rollback case runs the real transaction and throws after the tail has
// enqueued, proving the outbox row, the order CAS and the marker all roll back
// together.
//
// The CAS-loser case uses a read-only STALE view of the order repository (the
// operator observed PAYMENT_FAILED) while the transaction observes the real
// CONFIRMED row, so the in-transaction CAS genuinely loses.
//
// Proves against real PostgreSQL:
//   success          -> order CONFIRMED + marker CONVERGED/manual_review=false
//                       + exactly one durable PaymentSucceeded child row
//   duplicate/retry  -> rejected, zero additional child rows
//   CAS loser        -> CONCURRENT_MODIFICATION, zero rows, marker/order unchanged
//   forced rollback  -> zero child rows AND order/marker reverted
//   gateway boundary -> gateway exercised, zero gateway calls inside a tx
//
// Memory mode cannot prove transactional atomicity
// (MEMORY_ATOMICITY_GUARANTEE = NONE).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { OrderStatus } from "@snakzap/types";
import type { DrizzleDb } from "../src/lib/dbType";
import type {
  PaymentTransactionPort,
  PaymentTxRepos,
} from "../src/repositories/paymentAtomicityContracts";
import { DrizzlePaymentTransactionPort } from "../src/repositories/drizzle/paymentTransactionPort";
import { DrizzlePaymentRepository } from "../src/repositories/drizzle/drizzlePaymentRepository";
import { DrizzleOrderRepository } from "../src/repositories/drizzle/drizzleOrderRepository";
import type { OrderRepository } from "../src/repositories/orderRepository";
import { DrizzleGiftRepository } from "../src/repositories/drizzle/drizzleGiftRepository";
import type { RazorpayPaymentEntity } from "../src/services/razorpay";
import type { RefundDisposition } from "../src/services/orderRefund";
import {
  PaymentManualReviewService,
  type ManualReviewGateway,
  type ManualReviewRefundService,
} from "../src/services/paymentManualReview";

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

const PREFIX = "pay-b2-";

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

async function countByAgg(
  db: DrizzleDb,
  eventName: string,
  aggregateId: string,
): Promise<number> {
  const res = (await exec(
    db,
    sql`SELECT count(*)::text AS n FROM event_outbox
        WHERE event_name = ${eventName} AND aggregate_id = ${aggregateId}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

async function eventIdFor(
  db: DrizzleDb,
  eventName: string,
  aggregateId: string,
): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT event_id FROM event_outbox
        WHERE event_name = ${eventName} AND aggregate_id = ${aggregateId}`,
  )) as unknown as { rows: { event_id: string }[] };
  return res.rows[0]?.event_id ?? null;
}

async function orderStatus(db: DrizzleDb, orderId: string): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT status FROM orders WHERE id = ${orderId}`,
  )) as unknown as { rows: { status: string }[] };
  return res.rows[0]?.status ?? null;
}

async function reconOf(db: DrizzleDb, paymentId: string): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT reconciliation_status AS s FROM payments WHERE id = ${paymentId}`,
  )) as unknown as { rows: { s: string | null }[] };
  return res.rows[0]?.s ?? null;
}

async function manualReviewFlag(db: DrizzleDb, paymentId: string): Promise<boolean | null> {
  const res = (await exec(
    db,
    sql`SELECT manual_review AS m FROM payments WHERE id = ${paymentId}`,
  )) as unknown as { rows: { m: boolean }[] };
  return res.rows[0]?.m ?? null;
}

/**
 * Tracks whether a transaction is open and whether the gateway double was ever
 * invoked while one was. This is the external-call-outside-tx probe.
 */
class TxProbe {
  inTx = false;
  gatewayCalls = 0;
  gatewayCallsInTx = 0;
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
 *  transaction (order CAS + outbox row + marker) rolls back. */
class RollbackAfterPort implements PaymentTransactionPort {
  constructor(private readonly inner: PaymentTransactionPort) {}

  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      await fn(repos);
      throw new Error("pay-b2-force-rollback");
    });
  }
}

class ProbeGateway implements ManualReviewGateway {
  payments: RazorpayPaymentEntity[] = [];

  constructor(private readonly probe: TxProbe) {}

  async fetchPayment(paymentId: string): Promise<RazorpayPaymentEntity | null> {
    this.probe.gatewayCalls += 1;
    if (this.probe.inTx) this.probe.gatewayCallsInTx += 1;
    return this.payments.find((p) => p.id === paymentId) ?? null;
  }

  reset(): void {
    this.payments.length = 0;
  }
}

class NoopRefundService implements ManualReviewRefundService {
  async submitFullRefundForCapturedPayment(): Promise<RefundDisposition> {
    throw new Error("pay-b2: refund path must not be reached in RECOVER tests");
  }
}

function capturedEntity(id: string, orderId: string, amountPaise: number): RazorpayPaymentEntity {
  return {
    id,
    order_id: orderId,
    amount: amountPaise,
    currency: "INR",
    status: "captured",
    captured: true,
    method: "upi",
  };
}

/**
 * Read-only stale view: reports a fixed status for one order while every write
 * still lands on the real repository. The transaction reaches the real row, so
 * its CAS genuinely loses.
 */
function staleStatusOrderRepo(
  inner: OrderRepository,
  orderId: string,
  staleStatus: OrderStatus,
): OrderRepository {
  return new Proxy(inner as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "getById") {
        return async (id: string) => {
          const order = await inner.getById(id);
          if (order && id === orderId) return { ...order, status: staleStatus };
          return order;
        };
      }
      const value = target[prop as string];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(inner)
        : value;
    },
  }) as unknown as OrderRepository;
}

interface World {
  userId: string;
  restaurantId: string;
}

interface Created {
  users: string[];
  restaurants: string[];
  orders: string[];
  aggregates: string[];
}

async function seedWorld(db: DrizzleDb, created: Created): Promise<World> {
  const userId = randomUUID();
  const restaurantId = randomUUID();
  created.users.push(userId);
  created.restaurants.push(restaurantId);

  await exec(
    db,
    sql`INSERT INTO users (id, phone) VALUES (${userId}, ${`${PREFIX}${randomUUID()}`})`,
  );
  await exec(
    db,
    sql`INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
        VALUES (${restaurantId}, ${userId}, ${`PAYB2-R-${randomUUID().slice(0, 8)}`},
                ${`GST${randomUUID().replace(/-/g, "").slice(0, 12)}`},
                ${`FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`}, true)`,
  );
  return { userId, restaurantId };
}

async function seedOrder(
  db: DrizzleDb,
  w: World,
  created: Created,
  status: string,
  total: number,
): Promise<string> {
  const orderId = randomUUID();
  created.orders.push(orderId);
  created.aggregates.push(orderId);
  await exec(
    db,
    sql`INSERT INTO orders (id, user_id, restaurant_id, total_amount, status)
        VALUES (${orderId}, ${w.userId}, ${w.restaurantId}, ${total}, ${status})`,
  );
  return orderId;
}

interface SeedPaymentOptions {
  orderId: string;
  rpOrderId: string;
  amount: number;
  razorpayPaymentId: string;
}

async function seedCapturedPayment(db: DrizzleDb, opts: SeedPaymentOptions): Promise<string> {
  const id = randomUUID();
  const metadata = { currency: "INR", razorpay_payment_id: opts.razorpayPaymentId };
  await exec(
    db,
    sql`INSERT INTO payments
          (id, order_id, provider_transaction_id, amount, status, metadata)
        VALUES (${id}, ${opts.orderId}, ${opts.rpOrderId}, ${opts.amount}, 'CAPTURED',
                ${JSON.stringify(metadata)}::jsonb)`,
  );
  return id;
}

async function markManualReview(db: DrizzleDb, paymentId: string): Promise<void> {
  await exec(
    db,
    sql`UPDATE payments
        SET reconciliation_status = 'MANUAL_REVIEW',
            reconciliation_reason = 'PAYMENT_FAILED_RECOVERY_INTEGRITY_FAILED',
            manual_review = true,
            last_reconciled_at = now()
        WHERE id = ${paymentId}`,
  );
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "(no error)";
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return e.code ?? e.message ?? "(unknown)";
  }
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 6 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  const paymentRepo = new DrizzlePaymentRepository(db);
  const orderRepo = new DrizzleOrderRepository(db);
  const giftRepo = new DrizzleGiftRepository(db);
  const refundService = new NoopRefundService();

  const probe = new TxProbe();
  const gateway = new ProbeGateway(probe);
  const realPort = new DrizzlePaymentTransactionPort(db);
  const successPort = new ProbePort(realPort, probe);
  const rollbackPort = new ProbePort(new RollbackAfterPort(realPort), probe);

  const created: Created = { users: [], restaurants: [], orders: [], aggregates: [] };

  try {
    const present = (await exec(
      db,
      sql`SELECT to_regclass('event_outbox') IS NOT NULL AS a,
                 to_regclass('payments') IS NOT NULL AS b,
                 to_regclass('orders') IS NOT NULL AS c,
                 to_regclass('users') IS NOT NULL AS d,
                 to_regclass('restaurants') IS NOT NULL AS e`,
    )) as unknown as {
      rows: { a: boolean; b: boolean; c: boolean; d: boolean; e: boolean }[];
    };
    const r0 = present.rows[0];
    check(
      r0?.a === true && r0?.b === true && r0?.c === true && r0?.d === true && r0?.e === true,
      "PAYB2-PG-0 required tables present",
    );

    // =========================================================
    // MR-PG-1: success + duplicate
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const orderId = await seedOrder(db, w, created, "PAYMENT_FAILED", 50);
      const rpOrderId = `order_mock_payb2_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedCapturedPayment(db, {
        orderId,
        rpOrderId,
        amount: 50,
        razorpayPaymentId: "pay_payb2_success",
      });
      await markManualReview(db, paymentId);
      gateway.reset();
      gateway.payments.push(capturedEntity("pay_payb2_success", rpOrderId, 5000));

      const service = new PaymentManualReviewService({
        orderRepo,
        paymentRepo,
        giftRepo,
        gateway,
        refundService,
        txPort: successPort,
      });

      const result = await service.resolve(orderId, {
        action: "RECOVER_TO_CONFIRMED",
        from_status: "PAYMENT_FAILED",
      });
      check(result.order_status === "CONFIRMED", "PAYB2-PG-1 result CONFIRMED");
      check((await orderStatus(db, orderId)) === "CONFIRMED", "PAYB2-PG-1 order CONFIRMED");
      check((await reconOf(db, paymentId)) === "CONVERGED", "PAYB2-PG-1 marker CONVERGED");
      check(
        (await manualReviewFlag(db, paymentId)) === false,
        "PAYB2-PG-1 manual_review cleared",
      );
      check(
        (await countByAgg(db, "PaymentSucceeded", orderId)) === 1,
        "PAYB2-PG-1 success_exactly_one child row",
      );
      check(
        (await eventIdFor(db, "PaymentSucceeded", orderId)) !== null,
        "PAYB2-PG-1 durable event_id present",
      );

      const dupCode = await errorCode(
        service.resolve(orderId, {
          action: "RECOVER_TO_CONFIRMED",
          from_status: "PAYMENT_FAILED",
        }),
      );
      check(
        dupCode === "CONCURRENT_MODIFICATION" || dupCode === "PAYMENT_NOT_IN_MANUAL_REVIEW",
        `PAYB2-PG-1 duplicate rejected (${dupCode})`,
      );
      check(
        (await countByAgg(db, "PaymentSucceeded", orderId)) === 1,
        "PAYB2-PG-1 duplicate_zero additional child rows",
      );
    }

    // =========================================================
    // MR-PG-2: CAS loser (stale operator view, real row already CONFIRMED)
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const orderId = await seedOrder(db, w, created, "CONFIRMED", 50);
      const rpOrderId = `order_mock_payb2_cas_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedCapturedPayment(db, {
        orderId,
        rpOrderId,
        amount: 50,
        razorpayPaymentId: "pay_payb2_cas",
      });
      await markManualReview(db, paymentId);
      gateway.reset();
      gateway.payments.push(capturedEntity("pay_payb2_cas", rpOrderId, 5000));

      const staleRepo = staleStatusOrderRepo(orderRepo, orderId, "PAYMENT_FAILED");
      const service = new PaymentManualReviewService({
        orderRepo: staleRepo,
        paymentRepo,
        giftRepo,
        gateway,
        refundService,
        txPort: successPort,
      });

      const code = await errorCode(
        service.resolve(orderId, {
          action: "RECOVER_TO_CONFIRMED",
          from_status: "PAYMENT_FAILED",
        }),
      );
      check(code === "CONCURRENT_MODIFICATION", "PAYB2-PG-2 CAS loser rejected");
      check(
        (await countByAgg(db, "PaymentSucceeded", orderId)) === 0,
        "PAYB2-PG-2 zero child rows",
      );
      check((await orderStatus(db, orderId)) === "CONFIRMED", "PAYB2-PG-2 order unchanged");
      check((await reconOf(db, paymentId)) === "MANUAL_REVIEW", "PAYB2-PG-2 marker unchanged");
      check(
        (await manualReviewFlag(db, paymentId)) === true,
        "PAYB2-PG-2 manual_review unchanged",
      );
    }

    // =========================================================
    // MR-PG-3: forced rollback after the tail has run
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const orderId = await seedOrder(db, w, created, "PAYMENT_FAILED", 50);
      const rpOrderId = `order_mock_payb2_rb_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedCapturedPayment(db, {
        orderId,
        rpOrderId,
        amount: 50,
        razorpayPaymentId: "pay_payb2_rb",
      });
      await markManualReview(db, paymentId);
      gateway.reset();
      gateway.payments.push(capturedEntity("pay_payb2_rb", rpOrderId, 5000));

      const service = new PaymentManualReviewService({
        orderRepo,
        paymentRepo,
        giftRepo,
        gateway,
        refundService,
        txPort: rollbackPort,
      });

      const code = await errorCode(
        service.resolve(orderId, {
          action: "RECOVER_TO_CONFIRMED",
          from_status: "PAYMENT_FAILED",
        }),
      );
      check(code === "pay-b2-force-rollback", "PAYB2-PG-3 rollback surfaced");
      check(
        (await orderStatus(db, orderId)) === "PAYMENT_FAILED",
        "PAYB2-PG-3 rollback order unchanged",
      );
      check((await reconOf(db, paymentId)) === "MANUAL_REVIEW", "PAYB2-PG-3 rollback marker reverted");
      check(
        (await manualReviewFlag(db, paymentId)) === true,
        "PAYB2-PG-3 rollback manual_review reverted",
      );
      check(
        (await countByAgg(db, "PaymentSucceeded", orderId)) === 0,
        "PAYB2-PG-3 rollback child rows == 0",
      );
    }

    // =========================================================
    // External-call-outside-tx probe
    // =========================================================
    check(probe.gatewayCalls > 0, "PAYB2-PG-PROBE gateway exercised");
    check(
      probe.gatewayCallsInTx === 0,
      "PAYB2-PG-PROBE zero gateway calls inside a transaction",
    );
  } finally {
    for (const orderId of created.orders) {
      await pool.query(`DELETE FROM payments WHERE order_id = $1`, [orderId]);
      await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
    }
    for (const restaurantId of created.restaurants) {
      await pool.query(`DELETE FROM restaurants WHERE id = $1`, [restaurantId]);
    }
    for (const userId of created.users) {
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    if (created.aggregates.length > 0) {
      await pool.query(`DELETE FROM event_outbox WHERE aggregate_id = ANY($1::text[])`, [
        created.aggregates,
      ]);
    }
    await pool.end();
  }

  if (failures > 0) {
    console.error(`RESULT: FAIL (${failures} failed)`);
    process.exit(1);
  }
  console.log("RESULT: PASS (all PAY-B2 M1 real-PG manual-review atomicity checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
