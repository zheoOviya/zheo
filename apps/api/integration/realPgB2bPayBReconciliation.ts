// ============================================================
// EVT-B2B-PAY-B1 — Real PostgreSQL proof that the reconciliation convergence
// tails (R1-R5) enqueue their event on the SAME transaction as the local
// business mutation and the reconciliation-result marker (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with a disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<fresh migrated DB> \
//   pnpm exec tsx apps/api/integration/realPgB2bPayBReconciliation.ts
//
// The target DB is created fresh and fully migrated with
// `pnpm --filter @snakzap/db exec drizzle-kit migrate` (all 28 migrations).
//
// SCOPE NOTE (truthful limitation): this harness drives the REAL
// reconcilePayment over the REAL DrizzlePaymentTransactionPort (tx-scoped
// repositories + real DrizzleEventOutboxRepository on the same `tx`) and a
// deterministic OFFLINE gateway double. It does NOT mock the outbox: the
// default outbox.enqueue path runs. Gateway reads are proven to happen OUTSIDE
// the transaction via a probe port that fails if any gateway method is called
// while a transaction is open. Rollback cases use a thin test-only wrapper that
// discards the callback result and throws INSIDE the transaction after the tail
// has enqueued, proving the outbox row is truly part of the rolled-back
// transaction.
//
// Proves, per tail, against real PostgreSQL:
//   success          -> exactly one durable child row (stable event_id) + marker
//   duplicate/retry  -> zero additional child rows
//   rollback         -> zero child rows AND zero business effect
//
// R1 note: `reconcileCreated` performs a preliminary CREATED->CAPTURED capture
// CAS to identify the gateway entity BEFORE the transactional gift tail. That
// preamble is not part of the R1 tail (audit site: markPaid CAS + emit), so the
// R1 rollback case asserts the gift tail and its event revert while the
// preamble capture CAS persists.
//
// Memory mode cannot prove any of this
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
import { DrizzleOrderRepository } from "../src/repositories/drizzle/drizzleOrderRepository";
import { DrizzleGiftRepository } from "../src/repositories/drizzle/drizzleGiftRepository";
import {
  reconcilePayment,
  type ReconciliationDeps,
  type ReconciliationGateway,
} from "../src/services/paymentReconciliation";
import type {
  RazorpayOrderEntity,
  RazorpayPaymentEntity,
  RazorpayRefundEntity,
} from "../src/services/razorpay";

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

const PREFIX = "pay-b-";

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

async function statusOf(
  db: DrizzleDb,
  table: "orders" | "gifts" | "payments",
  id: string,
): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT status FROM ${sql.raw(table)} WHERE id = ${id}`,
  )) as unknown as { rows: { status: string }[] };
  return res.rows[0]?.status ?? null;
}

async function reconOf(
  db: DrizzleDb,
  paymentId: string,
): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT reconciliation_status AS s FROM payments WHERE id = ${paymentId}`,
  )) as unknown as { rows: { s: string }[] };
  return res.rows[0]?.s ?? null;
}

/**
 * Tracks whether a transaction is currently open and whether the gateway double
 * was ever invoked while one was. This is the external-call-outside-tx probe.
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
 *  transaction (including any enqueued child rows) rolls back. */
class RollbackAfterPort implements PaymentTransactionPort {
  constructor(private readonly inner: PaymentTransactionPort) {}

  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      await fn(repos);
      throw new Error("pay-b-force-rollback");
    });
  }
}

class FakeGateway implements ReconciliationGateway {
  payments: RazorpayPaymentEntity[] = [];
  refunds: RazorpayRefundEntity[] = [];

  constructor(private readonly probe: TxProbe) {}

  private note(): void {
    this.probe.gatewayCalls += 1;
    if (this.probe.inTx) this.probe.gatewayCallsInTx += 1;
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPaymentEntity | null> {
    this.note();
    return this.payments.find((p) => p.id === paymentId) ?? null;
  }
  async fetchOrder(razorpayOrderId: string): Promise<RazorpayOrderEntity | null> {
    this.note();
    void razorpayOrderId;
    return null;
  }
  async fetchPaymentsForOrder(razorpayOrderId: string): Promise<RazorpayPaymentEntity[]> {
    this.note();
    return this.payments.filter((p) => p.order_id === razorpayOrderId);
  }
  async fetchRefund(refundId: string): Promise<RazorpayRefundEntity | null> {
    this.note();
    return this.refunds.find((r) => r.id === refundId) ?? null;
  }
  async fetchRefundsForPayment(paymentId: string): Promise<RazorpayRefundEntity[]> {
    this.note();
    return this.refunds.filter((r) => r.payment_id === paymentId);
  }

  reset(): void {
    this.payments.length = 0;
    this.refunds.length = 0;
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

function fullRefundEntity(id: string, paymentId: string, amountPaise: number): RazorpayRefundEntity {
  return { id, payment_id: paymentId, amount: amountPaise, currency: "INR", status: "processed" };
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
  orders: string[];
  gifts: string[];
  aggregates: string[];
}

async function seedWorld(db: DrizzleDb, created: Created): Promise<World> {
  const userId = randomUUID();
  const restaurantId = randomUUID();
  const menuItemId = randomUUID();
  created.users.push(userId);
  created.restaurants.push(restaurantId);
  created.menuItems.push(menuItemId);

  await exec(db, sql`INSERT INTO users (id, phone) VALUES (${userId}, ${`${PREFIX}${randomUUID()}`})`);
  await exec(
    db,
    sql`INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
        VALUES (${restaurantId}, ${userId}, ${`PAYB-R-${randomUUID().slice(0, 8)}`},
                ${`GST${randomUUID().replace(/-/g, "").slice(0, 12)}`},
                ${`FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`}, true)`,
  );
  await exec(
    db,
    sql`INSERT INTO menu_items (id, restaurant_id, name, price)
        VALUES (${menuItemId}, ${restaurantId}, ${`MI-${randomUUID().slice(0, 8)}`}, 50.00)`,
  );
  return { userId, restaurantId, menuItemId };
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

async function seedGift(
  db: DrizzleDb,
  w: World,
  created: Created,
  status: string,
): Promise<string> {
  const giftId = randomUUID();
  created.gifts.push(giftId);
  created.aggregates.push(giftId);
  const snapshot = JSON.stringify({
    name: `Gift-${randomUUID().slice(0, 6)}`,
    price: 50,
    image_url: null,
    dietary_tags: {},
    spice_level: 1,
    customizations: [],
  });
  await exec(
    db,
    sql`INSERT INTO gifts
          (id, sender_id, restaurant_id, menu_item_id, item_snapshot, price_paid,
           claim_token, claim_code, status, expires_at)
        VALUES (${giftId}, ${w.userId}, ${w.restaurantId}, ${w.menuItemId},
                ${snapshot}::jsonb, 50.00,
                ${`${PREFIX}tok-${randomUUID()}`}, ${`GB${randomUUID().replace(/-/g, "").slice(0, 8)}`},
                ${status}, now() + interval '90 days')`,
  );
  return giftId;
}

interface SeedPaymentOptions {
  orderId?: string;
  giftId?: string;
  rpOrderId: string;
  amount: number;
  status?: string;
  razorpayPaymentId?: string;
}

async function seedPayment(db: DrizzleDb, opts: SeedPaymentOptions): Promise<string> {
  const id = randomUUID();
  const metadata: Record<string, unknown> = { currency: "INR" };
  if (opts.razorpayPaymentId) metadata.razorpay_payment_id = opts.razorpayPaymentId;
  await exec(
    db,
    sql`INSERT INTO payments
          (id, order_id, gift_id, provider_transaction_id, amount, status, metadata)
        VALUES (${id}, ${opts.orderId ?? null}, ${opts.giftId ?? null},
                ${opts.rpOrderId}, ${opts.amount}, ${opts.status ?? "CREATED"},
                ${JSON.stringify(metadata)}::jsonb)`,
  );
  return id;
}

function deps(
  paymentRepo: DrizzlePaymentRepository,
  orderRepo: DrizzleOrderRepository,
  giftRepo: DrizzleGiftRepository,
  gateway: ReconciliationGateway,
  txPort: PaymentTransactionPort,
): ReconciliationDeps {
  return { paymentRepo, orderRepo, giftRepo, gateway, txPort };
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 6 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  const paymentRepo = new DrizzlePaymentRepository(db);
  const orderRepo = new DrizzleOrderRepository(db);
  const giftRepo = new DrizzleGiftRepository(db);

  const probe = new TxProbe();
  const gateway = new FakeGateway(probe);
  const realPort = new DrizzlePaymentTransactionPort(db);
  const successPort = new ProbePort(realPort, probe);
  const rollbackPort = new ProbePort(new RollbackAfterPort(realPort), probe);

  const created: Created = {
    users: [],
    restaurants: [],
    menuItems: [],
    orders: [],
    gifts: [],
    aggregates: [],
  };

  try {
    const present = (await exec(
      db,
      sql`SELECT to_regclass('event_outbox') IS NOT NULL AS a,
                 to_regclass('payments') IS NOT NULL AS b,
                 to_regclass('orders') IS NOT NULL AS c,
                 to_regclass('gifts') IS NOT NULL AS d,
                 to_regclass('users') IS NOT NULL AS e,
                 to_regclass('restaurants') IS NOT NULL AS f,
                 to_regclass('menu_items') IS NOT NULL AS g`,
    )) as unknown as {
      rows: { a: boolean; b: boolean; c: boolean; d: boolean; e: boolean; f: boolean; g: boolean }[];
    };
    const r0 = present.rows[0];
    check(
      r0?.a === true &&
        r0?.b === true &&
        r0?.c === true &&
        r0?.d === true &&
        r0?.e === true &&
        r0?.f === true &&
        r0?.g === true,
      "PAYB-PG-0 required tables present",
    );

    // =========================================================
    // R1: GiftPaid — CREATED gift payment captured by gateway
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const giftId = await seedGift(db, w, created, "PENDING");
      const rpOrderId = `order_mock_payb_r1_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedPayment(db, { giftId, rpOrderId, amount: 50 });
      gateway.reset();
      gateway.payments.push(capturedEntity("pay_payb_r1", rpOrderId, 5000));

      const result = await reconcilePayment(
        paymentId,
        deps(paymentRepo, orderRepo, giftRepo, gateway, successPort),
      );
      check(result.outcome === "CONVERGED" && result.emitted === true, "PAYB-PG-R1 success outcome");
      check((await statusOf(db, "gifts", giftId)) === "ACTIVE", "PAYB-PG-R1 gift ACTIVE");
      check((await statusOf(db, "payments", paymentId)) === "CAPTURED", "PAYB-PG-R1 payment CAPTURED");
      check((await reconOf(db, paymentId)) === "CONVERGED", "PAYB-PG-R1 marker CONVERGED");
      check(
        (await countByAgg(db, "GiftPaid", giftId)) === 1,
        "PAYB-PG-R1 success_exactly_one child row",
      );
      check(
        (await eventIdFor(db, "GiftPaid", giftId)) !== null,
        "PAYB-PG-R1 durable event_id present",
      );

      await reconcilePayment(
        paymentId,
        deps(paymentRepo, orderRepo, giftRepo, gateway, successPort),
      );
      check(
        (await countByAgg(db, "GiftPaid", giftId)) === 1,
        "PAYB-PG-R1 duplicate_zero additional child rows",
      );

      const w2 = await seedWorld(db, created);
      const rbGift = await seedGift(db, w2, created, "PENDING");
      const rbRp = `order_mock_payb_r1_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment = await seedPayment(db, { giftId: rbGift, rpOrderId: rbRp, amount: 50 });
      gateway.reset();
      gateway.payments.push(capturedEntity("pay_payb_r1_rb", rbRp, 5000));
      const rbResult = await reconcilePayment(
        rbPayment,
        deps(paymentRepo, orderRepo, giftRepo, gateway, rollbackPort),
      );
      check(rbResult.outcome === "ERROR", "PAYB-PG-R1 rollback surfaced as ERROR");
      check((await statusOf(db, "gifts", rbGift)) === "PENDING", "PAYB-PG-R1 rollback gift unchanged");
      check(
        (await statusOf(db, "payments", rbPayment)) === "CAPTURED",
        "PAYB-PG-R1 rollback: gift tail + event reverted, pre-tail capture CAS persists",
      );
      check(
        (await countByAgg(db, "GiftPaid", rbGift)) === 0,
        "PAYB-PG-R1 rollback child rows == 0",
      );
    }

    // =========================================================
    // R2: PaymentSucceeded — CAPTURED payment + PAYMENT_PENDING order
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const orderId = await seedOrder(db, w, created, "PAYMENT_PENDING", 50);
      const rpOrderId = `order_mock_payb_r2_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedPayment(db, {
        orderId,
        rpOrderId,
        amount: 50,
        status: "CAPTURED",
        razorpayPaymentId: "pay_payb_r2",
      });
      gateway.reset();

      const result = await reconcilePayment(
        paymentId,
        deps(paymentRepo, orderRepo, giftRepo, gateway, successPort),
      );
      check(result.outcome === "CONVERGED" && result.emitted === true, "PAYB-PG-R2 success outcome");
      check((await statusOf(db, "orders", orderId)) === "CONFIRMED", "PAYB-PG-R2 order CONFIRMED");
      check((await reconOf(db, paymentId)) === "CONVERGED", "PAYB-PG-R2 marker CONVERGED");
      check(
        (await countByAgg(db, "PaymentSucceeded", orderId)) === 1,
        "PAYB-PG-R2 success_exactly_one child row",
      );

      const w2 = await seedWorld(db, created);
      const rbOrder = await seedOrder(db, w2, created, "PAYMENT_PENDING", 50);
      const rbRp = `order_mock_payb_r2_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment = await seedPayment(db, {
        orderId: rbOrder,
        rpOrderId: rbRp,
        amount: 50,
        status: "CAPTURED",
        razorpayPaymentId: "pay_payb_r2_rb",
      });
      gateway.reset();
      const rbResult = await reconcilePayment(
        rbPayment,
        deps(paymentRepo, orderRepo, giftRepo, gateway, rollbackPort),
      );
      check(rbResult.outcome === "ERROR", "PAYB-PG-R2 rollback surfaced as ERROR");
      check(
        (await statusOf(db, "orders", rbOrder)) === "PAYMENT_PENDING",
        "PAYB-PG-R2 rollback order unchanged",
      );
      check(
        (await countByAgg(db, "PaymentSucceeded", rbOrder)) === 0,
        "PAYB-PG-R2 rollback child rows == 0",
      );
    }

    // =========================================================
    // R3: PaymentSucceeded recovery — CAPTURED payment + PAYMENT_FAILED order
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const orderId = await seedOrder(db, w, created, "PAYMENT_FAILED", 50);
      const rpOrderId = `order_mock_payb_r3_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedPayment(db, {
        orderId,
        rpOrderId,
        amount: 50,
        status: "CAPTURED",
        razorpayPaymentId: "pay_payb_r3",
      });
      gateway.reset();
      gateway.payments.push(capturedEntity("pay_payb_r3", rpOrderId, 5000));

      const result = await reconcilePayment(
        paymentId,
        deps(paymentRepo, orderRepo, giftRepo, gateway, successPort),
      );
      check(result.outcome === "CONVERGED" && result.emitted === true, "PAYB-PG-R3 success outcome");
      check((await statusOf(db, "orders", orderId)) === "CONFIRMED", "PAYB-PG-R3 order RECOVERED");
      check((await reconOf(db, paymentId)) === "CONVERGED", "PAYB-PG-R3 marker CONVERGED");
      check(
        (await countByAgg(db, "PaymentSucceeded", orderId)) === 1,
        "PAYB-PG-R3 success_exactly_one child row",
      );

      const w2 = await seedWorld(db, created);
      const rbOrder = await seedOrder(db, w2, created, "PAYMENT_FAILED", 50);
      const rbRp = `order_mock_payb_r3_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment = await seedPayment(db, {
        orderId: rbOrder,
        rpOrderId: rbRp,
        amount: 50,
        status: "CAPTURED",
        razorpayPaymentId: "pay_payb_r3_rb",
      });
      gateway.reset();
      gateway.payments.push(capturedEntity("pay_payb_r3_rb", rbRp, 5000));
      const rbResult = await reconcilePayment(
        rbPayment,
        deps(paymentRepo, orderRepo, giftRepo, gateway, rollbackPort),
      );
      check(rbResult.outcome === "ERROR", "PAYB-PG-R3 rollback surfaced as ERROR");
      check(
        (await statusOf(db, "orders", rbOrder)) === "PAYMENT_FAILED",
        "PAYB-PG-R3 rollback order unchanged",
      );
      check(
        (await countByAgg(db, "PaymentSucceeded", rbOrder)) === 0,
        "PAYB-PG-R3 rollback child rows == 0",
      );
    }

    // =========================================================
    // R4: GiftRefunded — CAPTURED gift payment + full gateway refund
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const giftId = await seedGift(db, w, created, "ACTIVE");
      const rpOrderId = `order_mock_payb_r4_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedPayment(db, {
        giftId,
        rpOrderId,
        amount: 50,
        status: "CAPTURED",
        razorpayPaymentId: "pay_payb_r4",
      });
      gateway.reset();
      gateway.refunds.push(fullRefundEntity("rfnd_payb_r4", "pay_payb_r4", 5000));

      const result = await reconcilePayment(
        paymentId,
        deps(paymentRepo, orderRepo, giftRepo, gateway, successPort),
      );
      check(result.outcome === "CONVERGED" && result.emitted === true, "PAYB-PG-R4 success outcome");
      check((await statusOf(db, "payments", paymentId)) === "REFUNDED", "PAYB-PG-R4 payment REFUNDED");
      check((await statusOf(db, "gifts", giftId)) === "REFUNDED", "PAYB-PG-R4 gift REFUNDED");
      check((await reconOf(db, paymentId)) === "CONVERGED", "PAYB-PG-R4 marker CONVERGED");
      check(
        (await countByAgg(db, "GiftRefunded", giftId)) === 1,
        "PAYB-PG-R4 success_exactly_one child row",
      );

      await reconcilePayment(
        paymentId,
        deps(paymentRepo, orderRepo, giftRepo, gateway, successPort),
      );
      check(
        (await countByAgg(db, "GiftRefunded", giftId)) === 1,
        "PAYB-PG-R4 duplicate_zero additional child rows",
      );

      const w2 = await seedWorld(db, created);
      const rbGift = await seedGift(db, w2, created, "ACTIVE");
      const rbRp = `order_mock_payb_r4_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment = await seedPayment(db, {
        giftId: rbGift,
        rpOrderId: rbRp,
        amount: 50,
        status: "CAPTURED",
        razorpayPaymentId: "pay_payb_r4_rb",
      });
      gateway.reset();
      gateway.refunds.push(fullRefundEntity("rfnd_payb_r4_rb", "pay_payb_r4_rb", 5000));
      const rbResult = await reconcilePayment(
        rbPayment,
        deps(paymentRepo, orderRepo, giftRepo, gateway, rollbackPort),
      );
      check(rbResult.outcome === "ERROR", "PAYB-PG-R4 rollback surfaced as ERROR");
      check(
        (await statusOf(db, "payments", rbPayment)) === "CAPTURED",
        "PAYB-PG-R4 rollback payment unchanged",
      );
      check((await statusOf(db, "gifts", rbGift)) === "ACTIVE", "PAYB-PG-R4 rollback gift unchanged");
      check(
        (await countByAgg(db, "GiftRefunded", rbGift)) === 0,
        "PAYB-PG-R4 rollback child rows == 0",
      );
    }

    // =========================================================
    // R5: local REFUNDED convergence — gift and order variants
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const giftId = await seedGift(db, w, created, "REFUNDING");
      const rpOrderId = `order_mock_payb_r5g_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedPayment(db, {
        giftId,
        rpOrderId,
        amount: 50,
        status: "REFUNDED",
        razorpayPaymentId: "pay_payb_r5g",
      });
      gateway.reset();
      gateway.refunds.push(fullRefundEntity("rfnd_payb_r5g", "pay_payb_r5g", 5000));

      const result = await reconcilePayment(
        paymentId,
        deps(paymentRepo, orderRepo, giftRepo, gateway, successPort),
      );
      check(result.outcome === "CONVERGED" && result.emitted === true, "PAYB-PG-R5g success outcome");
      check((await statusOf(db, "gifts", giftId)) === "REFUNDED", "PAYB-PG-R5g gift REFUNDED");
      check((await reconOf(db, paymentId)) === "CONVERGED", "PAYB-PG-R5g marker CONVERGED");
      check(
        (await countByAgg(db, "GiftRefunded", giftId)) === 1,
        "PAYB-PG-R5g success_exactly_one child row",
      );

      const w2 = await seedWorld(db, created);
      const rbGift = await seedGift(db, w2, created, "REFUNDING");
      const rbRp = `order_mock_payb_r5g_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment = await seedPayment(db, {
        giftId: rbGift,
        rpOrderId: rbRp,
        amount: 50,
        status: "REFUNDED",
        razorpayPaymentId: "pay_payb_r5g_rb",
      });
      gateway.reset();
      gateway.refunds.push(fullRefundEntity("rfnd_payb_r5g_rb", "pay_payb_r5g_rb", 5000));
      const rbResult = await reconcilePayment(
        rbPayment,
        deps(paymentRepo, orderRepo, giftRepo, gateway, rollbackPort),
      );
      check(rbResult.outcome === "ERROR", "PAYB-PG-R5g rollback surfaced as ERROR");
      check(
        (await statusOf(db, "gifts", rbGift)) === "REFUNDING",
        "PAYB-PG-R5g rollback gift unchanged",
      );
      check(
        (await countByAgg(db, "GiftRefunded", rbGift)) === 0,
        "PAYB-PG-R5g rollback child rows == 0",
      );

      const w3 = await seedWorld(db, created);
      const orderId = await seedOrder(db, w3, created, "CONFIRMED", 50);
      const rpOrderId2 = `order_mock_payb_r5o_${randomUUID().slice(0, 8)}`;
      const paymentId2 = await seedPayment(db, {
        orderId,
        rpOrderId: rpOrderId2,
        amount: 50,
        status: "REFUNDED",
        razorpayPaymentId: "pay_payb_r5o",
      });
      gateway.reset();
      gateway.refunds.push(fullRefundEntity("rfnd_payb_r5o", "pay_payb_r5o", 5000));

      const result2 = await reconcilePayment(
        paymentId2,
        deps(paymentRepo, orderRepo, giftRepo, gateway, successPort),
      );
      check(result2.outcome === "CONVERGED", "PAYB-PG-R5o success outcome");
      check((await statusOf(db, "orders", orderId)) === "REFUNDED", "PAYB-PG-R5o order REFUNDED");
      check((await reconOf(db, paymentId2)) === "CONVERGED", "PAYB-PG-R5o marker CONVERGED");

      const w4 = await seedWorld(db, created);
      const rbOrder = await seedOrder(db, w4, created, "CONFIRMED", 50);
      const rbRp2 = `order_mock_payb_r5o_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment2 = await seedPayment(db, {
        orderId: rbOrder,
        rpOrderId: rbRp2,
        amount: 50,
        status: "REFUNDED",
        razorpayPaymentId: "pay_payb_r5o_rb",
      });
      gateway.reset();
      gateway.refunds.push(fullRefundEntity("rfnd_payb_r5o_rb", "pay_payb_r5o_rb", 5000));
      const rbResult2 = await reconcilePayment(
        rbPayment2,
        deps(paymentRepo, orderRepo, giftRepo, gateway, rollbackPort),
      );
      check(rbResult2.outcome === "ERROR", "PAYB-PG-R5o rollback surfaced as ERROR");
      check(
        (await statusOf(db, "orders", rbOrder)) === "CONFIRMED",
        "PAYB-PG-R5o rollback order unchanged",
      );
      check(
        (await countByAgg(db, "GiftRefunded", rbOrder)) === 0,
        "PAYB-PG-R5o rollback child rows == 0",
      );
    }

    // =========================================================
    // External-call-outside-tx probe
    // =========================================================
    check(probe.gatewayCalls > 0, "PAYB-PG-PROBE gateway exercised");
    check(
      probe.gatewayCallsInTx === 0,
      "PAYB-PG-PROBE zero gateway calls inside a transaction",
    );
  } finally {
    for (const orderId of created.orders) {
      await pool.query(`DELETE FROM payments WHERE order_id = $1`, [orderId]);
      await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
    }
    for (const giftId of created.gifts) {
      await pool.query(`DELETE FROM payments WHERE gift_id = $1`, [giftId]);
      await pool.query(`DELETE FROM gifts WHERE id = $1`, [giftId]);
    }
    for (const restaurantId of created.restaurants) {
      await pool.query(`DELETE FROM menu_items WHERE restaurant_id = $1`, [restaurantId]);
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
  console.log("RESULT: PASS (all PAY-B1 real-PG reconciliation atomicity checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
