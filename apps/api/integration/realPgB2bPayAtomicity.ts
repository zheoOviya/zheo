// ============================================================
// EVT-B2B-PAY-A — Real PostgreSQL proof that the five ordinary/local payment
// producers enqueue their event on the SAME transaction as the authoritative
// business mutation (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with a disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/evt_paya_run \
//   pnpm exec tsx apps/api/integration/realPgB2bPayAtomicity.ts
//
// `evt_paya_run` is a disposable DB created fresh and fully migrated with
// `pnpm --filter @snakzap/db exec drizzle-kit migrate` (all 28 migrations).
//
// SCOPE NOTE (truthful limitation): this harness drives the REAL PaymentService
// over the REAL DrizzlePaymentTransactionPort (real tx-scoped repositories +
// real DrizzleEventOutboxRepository on the same `tx`). It does NOT mock the
// emitter: the default outbox.enqueue path runs. Gateway calls are the offline
// Razorpay mock (no real keys) and never participate in the transaction. It
// seeds fixtures directly with SQL and reproduces only the preconditions each
// producer needs. The rollback cases use a thin test-only wrapper that discards
// the callback result and throws INSIDE the transaction after the service has
// enqueued, proving the outbox row is truly part of the rolled-back
// transaction.
//
// Proves, per scoped event, against real PostgreSQL:
//   success mutation -> exactly one durable child row (stable event_id)
//   duplicate/retry  -> zero additional child rows
//   rollback         -> zero child rows AND zero business effect
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
import { PaymentService } from "../src/services/payments";
import { razorpayService } from "../src/services/razorpay";

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

const PREFIX = "pay-a-";

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

/** Test-only wrapper: runs the real tx, then throws before commit so the whole
 *  transaction (including any enqueued child rows) rolls back. */
class RollbackAfterPaymentPort implements PaymentTransactionPort {
  constructor(private readonly inner: PaymentTransactionPort) {}

  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      await fn(repos);
      throw new Error("pay-force-rollback");
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
        VALUES (${restaurantId}, ${userId}, ${`PAYA-R-${randomUUID().slice(0, 8)}`},
                ${`GST${randomUUID().replace(/-/g, "").slice(0, 12)}`},
                ${`FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`}, true)`,
  );
  await exec(
    db,
    sql`INSERT INTO menu_items (id, restaurant_id, name, price)
        VALUES (${menuItemId}, ${restaurantId}, ${`MI-${randomUUID().slice(0, 8)}`}, 30.00)`,
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
  price: number,
): Promise<string> {
  const giftId = randomUUID();
  created.gifts.push(giftId);
  created.aggregates.push(giftId);
  const snapshot = JSON.stringify({
    name: `Gift-${randomUUID().slice(0, 6)}`,
    price,
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
                ${snapshot}::jsonb, ${price},
                ${`${PREFIX}tok-${randomUUID()}`}, ${`GC${randomUUID().replace(/-/g, "").slice(0, 8)}`},
                'PENDING', now() + interval '90 days')`,
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
  method?: string;
}

async function seedPayment(
  db: DrizzleDb,
  opts: SeedPaymentOptions,
): Promise<string> {
  const id = randomUUID();
  const metadata: Record<string, unknown> = { currency: "INR" };
  if (opts.razorpayPaymentId) metadata.razorpay_payment_id = opts.razorpayPaymentId;
  if (opts.method) metadata.method = opts.method;
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

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  const paymentRepo = new DrizzlePaymentRepository(db);
  const orderRepo = new DrizzleOrderRepository(db);
  const giftRepo = new DrizzleGiftRepository(db);
  const service = new PaymentService(
    paymentRepo,
    orderRepo,
    giftRepo,
    new DrizzlePaymentTransactionPort(db),
  );
  const rollbackService = new PaymentService(
    paymentRepo,
    orderRepo,
    giftRepo,
    new RollbackAfterPaymentPort(new DrizzlePaymentTransactionPort(db)),
  );

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
      rows: {
        a: boolean;
        b: boolean;
        c: boolean;
        d: boolean;
        e: boolean;
        f: boolean;
        g: boolean;
      }[];
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
      "PAYA-PG-0 required tables present",
    );

    // =========================================================
    // P1: CashOnPickupSelected — createPaymentOrder(cod)
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const orderId = await seedOrder(db, w, created, "DRAFT", 100);
      const out = await service.createPaymentOrder(orderId, "cod", w.userId);
      check(out.payment_method === "cod", "PAYA-PG-P1 success outcome");
      check((await statusOf(db, "orders", orderId)) === "CONFIRMED", "PAYA-PG-P1 order CONFIRMED");
      check(
        (await countByAgg(db, "CashOnPickupSelected", orderId)) === 1,
        "PAYA-PG-P1 success_exactly_one child row",
      );
      check(
        (await eventIdFor(db, "CashOnPickupSelected", orderId)) !== null,
        "PAYA-PG-P1 durable event_id present",
      );

      let dupCode = "";
      try {
        await service.createPaymentOrder(orderId, "cod", w.userId);
      } catch (err) {
        dupCode = (err as { code?: string }).code ?? "";
      }
      check(dupCode === "ORDER_NOT_DRAFT", "PAYA-PG-P1 duplicate rejected (ORDER_NOT_DRAFT)");
      check(
        (await countByAgg(db, "CashOnPickupSelected", orderId)) === 1,
        "PAYA-PG-P1 duplicate_zero additional child rows",
      );

      const wrb = await seedWorld(db, created);
      const rbOrder = await seedOrder(db, wrb, created, "DRAFT", 100);
      let threw = false;
      try {
        await rollbackService.createPaymentOrder(rbOrder, "cod", wrb.userId);
      } catch {
        threw = true;
      }
      check(threw, "PAYA-PG-P1 rollback propagated");
      check((await statusOf(db, "orders", rbOrder)) === "DRAFT", "PAYA-PG-P1 rollback order effect == 0");
      check(
        (await countByAgg(db, "CashOnPickupSelected", rbOrder)) === 0,
        "PAYA-PG-P1 rollback child rows == 0",
      );
    }

    // =========================================================
    // P3: PaymentSucceeded — order capture webhook
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const orderId = await seedOrder(db, w, created, "PAYMENT_PENDING", 100);
      const rpOrderId = `order_mock_paya_p3_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedPayment(db, {
        orderId,
        rpOrderId,
        amount: 100,
      });
      const mock = razorpayService.buildMockWebhook(rpOrderId, 10000, "payment.captured");
      const out = await service.processWebhook(mock.rawBody, mock.signature);
      check(out.orderStatus === "CONFIRMED", "PAYA-PG-P3 success outcome");
      check((await statusOf(db, "orders", orderId)) === "CONFIRMED", "PAYA-PG-P3 order CONFIRMED");
      check(
        (await statusOf(db, "payments", paymentId)) === "CAPTURED",
        "PAYA-PG-P3 payment CAPTURED",
      );
      check(
        (await countByAgg(db, "PaymentSucceeded", orderId)) === 1,
        "PAYA-PG-P3 success_exactly_one child row",
      );
      check(
        (await eventIdFor(db, "PaymentSucceeded", orderId)) !== null,
        "PAYA-PG-P3 durable event_id present",
      );

      const dup = await service.processWebhook(mock.rawBody, mock.signature);
      check(
        dup.processed === false && dup.idempotent === true,
        "PAYA-PG-P3 duplicate idempotent",
      );
      check(
        (await countByAgg(db, "PaymentSucceeded", orderId)) === 1,
        "PAYA-PG-P3 duplicate_zero additional child rows",
      );

      const wrb = await seedWorld(db, created);
      const rbOrder = await seedOrder(db, wrb, created, "PAYMENT_PENDING", 100);
      const rbRp = `order_mock_paya_p3_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment = await seedPayment(db, { orderId: rbOrder, rpOrderId: rbRp, amount: 100 });
      const rbMock = razorpayService.buildMockWebhook(rbRp, 10000, "payment.captured");
      let threw = false;
      try {
        await rollbackService.processWebhook(rbMock.rawBody, rbMock.signature);
      } catch {
        threw = true;
      }
      check(threw, "PAYA-PG-P3 rollback propagated");
      check(
        (await statusOf(db, "orders", rbOrder)) === "PAYMENT_PENDING",
        "PAYA-PG-P3 rollback order status unchanged",
      );
      check(
        (await statusOf(db, "payments", rbPayment)) === "CREATED",
        "PAYA-PG-P3 rollback payment status unchanged",
      );
      check(
        (await countByAgg(db, "PaymentSucceeded", rbOrder)) === 0,
        "PAYA-PG-P3 rollback child rows == 0",
      );
    }

    // =========================================================
    // P4: PaymentFailed — order failure webhook
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const orderId = await seedOrder(db, w, created, "PAYMENT_PENDING", 100);
      const rpOrderId = `order_mock_paya_p4_${randomUUID().slice(0, 8)}`;
      await seedPayment(db, { orderId, rpOrderId, amount: 100 });
      const mock = razorpayService.buildMockWebhook(rpOrderId, 10000, "payment.failed", "declined");
      const out = await service.processWebhook(mock.rawBody, mock.signature);
      check(out.orderStatus === "PAYMENT_FAILED", "PAYA-PG-P4 success outcome");
      check(
        (await statusOf(db, "orders", orderId)) === "PAYMENT_FAILED",
        "PAYA-PG-P4 order PAYMENT_FAILED",
      );
      check(
        (await countByAgg(db, "PaymentFailed", orderId)) === 1,
        "PAYA-PG-P4 success_exactly_one child row",
      );

      const dup = await service.processWebhook(mock.rawBody, mock.signature);
      check(dup.idempotent === true, "PAYA-PG-P4 duplicate idempotent");
      check(
        (await countByAgg(db, "PaymentFailed", orderId)) === 1,
        "PAYA-PG-P4 duplicate_zero additional child rows",
      );

      const wrb = await seedWorld(db, created);
      const rbOrder = await seedOrder(db, wrb, created, "PAYMENT_PENDING", 100);
      const rbRp = `order_mock_paya_p4_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment = await seedPayment(db, { orderId: rbOrder, rpOrderId: rbRp, amount: 100 });
      const rbMock = razorpayService.buildMockWebhook(rbRp, 10000, "payment.failed", "declined");
      let threw = false;
      try {
        await rollbackService.processWebhook(rbMock.rawBody, rbMock.signature);
      } catch {
        threw = true;
      }
      check(threw, "PAYA-PG-P4 rollback propagated");
      check(
        (await statusOf(db, "orders", rbOrder)) === "PAYMENT_PENDING",
        "PAYA-PG-P4 rollback order status unchanged",
      );
      check(
        (await statusOf(db, "payments", rbPayment)) === "CREATED",
        "PAYA-PG-P4 rollback payment status unchanged",
      );
      check(
        (await countByAgg(db, "PaymentFailed", rbOrder)) === 0,
        "PAYA-PG-P4 rollback child rows == 0",
      );
    }

    // =========================================================
    // P2: GiftPaid — gift capture webhook
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const giftId = await seedGift(db, w, created, 30);
      const rpOrderId = `order_mock_paya_g2_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedPayment(db, { giftId, rpOrderId, amount: 30 });
      const mock = razorpayService.buildMockWebhook(rpOrderId, 3000, "payment.captured");
      const out = await service.processWebhook(mock.rawBody, mock.signature);
      check(out.giftStatus === "ACTIVE", "PAYA-PG-G2 success outcome");
      check((await statusOf(db, "gifts", giftId)) === "ACTIVE", "PAYA-PG-G2 gift ACTIVE");
      check(
        (await statusOf(db, "payments", paymentId)) === "CAPTURED",
        "PAYA-PG-G2 payment CAPTURED",
      );
      check(
        (await countByAgg(db, "GiftPaid", giftId)) === 1,
        "PAYA-PG-G2 success_exactly_one child row",
      );

      const dup = await service.processWebhook(mock.rawBody, mock.signature);
      check(dup.idempotent === true, "PAYA-PG-G2 duplicate idempotent");
      check(
        (await countByAgg(db, "GiftPaid", giftId)) === 1,
        "PAYA-PG-G2 duplicate_zero additional child rows",
      );

      const wrb = await seedWorld(db, created);
      const rbGift = await seedGift(db, wrb, created, 30);
      const rbRp = `order_mock_paya_g2_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment = await seedPayment(db, { giftId: rbGift, rpOrderId: rbRp, amount: 30 });
      const rbMock = razorpayService.buildMockWebhook(rbRp, 3000, "payment.captured");
      let threw = false;
      try {
        await rollbackService.processWebhook(rbMock.rawBody, rbMock.signature);
      } catch {
        threw = true;
      }
      check(threw, "PAYA-PG-G2 rollback propagated");
      check((await statusOf(db, "gifts", rbGift)) === "PENDING", "PAYA-PG-G2 rollback gift unchanged");
      check(
        (await statusOf(db, "payments", rbPayment)) === "CREATED",
        "PAYA-PG-G2 rollback payment unchanged",
      );
      check((await countByAgg(db, "GiftPaid", rbGift)) === 0, "PAYA-PG-G2 rollback child rows == 0");
    }

    // =========================================================
    // P5: GiftRefunded — gift refund webhook
    // =========================================================
    {
      const w = await seedWorld(db, created);
      const giftId = await seedGift(db, w, created, 30);
      const rpOrderId = `order_mock_paya_g5_${randomUUID().slice(0, 8)}`;
      const paymentId = await seedPayment(db, { giftId, rpOrderId, amount: 30 });
      const captured = razorpayService.buildMockWebhook(rpOrderId, 3000, "payment.captured");
      await service.processWebhook(captured.rawBody, captured.signature);
      const rzpPaymentId = captured.payload.payload.payment.entity.id;
      // Enter the refund lifecycle exactly as the expiry sweep would.
      await giftRepo.markRefunding(giftId, ["ACTIVE"]);

      const refund = razorpayService.buildMockRefundWebhook(rzpPaymentId, 3000);
      const out = await service.processWebhook(refund.rawBody, refund.signature);
      check(out.giftStatus === "REFUNDED", "PAYA-PG-G5 success outcome");
      check((await statusOf(db, "gifts", giftId)) === "REFUNDED", "PAYA-PG-G5 gift REFUNDED");
      check(
        (await statusOf(db, "payments", paymentId)) === "REFUNDED",
        "PAYA-PG-G5 payment REFUNDED",
      );
      check(
        (await countByAgg(db, "GiftRefunded", giftId)) === 1,
        "PAYA-PG-G5 success_exactly_one child row",
      );

      const dup = await service.processWebhook(refund.rawBody, refund.signature);
      check(dup.idempotent === true, "PAYA-PG-G5 duplicate idempotent");
      check(
        (await countByAgg(db, "GiftRefunded", giftId)) === 1,
        "PAYA-PG-G5 duplicate_zero additional child rows",
      );

      const wrb = await seedWorld(db, created);
      const rbGift = await seedGift(db, wrb, created, 30);
      const rbRp = `order_mock_paya_g5_rb_${randomUUID().slice(0, 8)}`;
      const rbPayment = await seedPayment(db, { giftId: rbGift, rpOrderId: rbRp, amount: 30 });
      const rbCaptured = razorpayService.buildMockWebhook(rbRp, 3000, "payment.captured");
      await service.processWebhook(rbCaptured.rawBody, rbCaptured.signature);
      const rbRzp = rbCaptured.payload.payload.payment.entity.id;
      await giftRepo.markRefunding(rbGift, ["ACTIVE"]);
      const rbRefund = razorpayService.buildMockRefundWebhook(rbRzp, 3000);
      let threw = false;
      try {
        await rollbackService.processWebhook(rbRefund.rawBody, rbRefund.signature);
      } catch {
        threw = true;
      }
      check(threw, "PAYA-PG-G5 rollback propagated");
      check(
        (await statusOf(db, "gifts", rbGift)) === "REFUNDING",
        "PAYA-PG-G5 rollback gift unchanged",
      );
      check(
        (await statusOf(db, "payments", rbPayment)) === "CAPTURED",
        "PAYA-PG-G5 rollback payment unchanged",
      );
      check(
        (await countByAgg(db, "GiftRefunded", rbGift)) === 0,
        "PAYA-PG-G5 rollback child rows == 0",
      );
    }
  } finally {
    // ---- fixture cleanup (FK-safe order) ----
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
  console.log("RESULT: PASS (all PAY-A real-PG payment atomicity checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
