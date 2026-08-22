import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../lib/dbType";
import { DrizzlePaymentRepository } from "../repositories/drizzle/drizzlePaymentRepository";
import { DrizzleOrderRepository } from "../repositories/drizzle/drizzleOrderRepository";
import { DrizzleGiftRepository } from "../repositories/drizzle/drizzleGiftRepository";
import type { OrderDTO } from "../repositories/orderRepository";
import type { PaymentDTO } from "../repositories/paymentRepository";
import { PaymentService, type PaymentInitiationResult } from "./payments";
import { razorpayService } from "./razorpay";
import { onEvent } from "../lib/eventBus";
import type { EventName } from "@snakzap/types";

// ============================================
// Task 4 real-PostgreSQL multi-instance proof.
//
// Two fully independent service stacks (separate pools, repos, PaymentService
// instances — separate instanceIds) contend on the SAME Postgres database and
// the SAME mock Razorpay gateway. Each test resets gateway state, so counts
// are deterministic per test. This suite skips cleanly when Postgres is down
// (unit suites still run in CI without PG).
// ============================================

const ADMIN_URL = "postgresql://snakzap:snakzap_test_pw@127.0.0.1:5432/snakzap_test";

function findDrizzleDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "packages/db/drizzle"),
    path.resolve(process.cwd(), "..", "packages/db/drizzle"),
    path.resolve(process.cwd(), "../..", "packages/db/drizzle"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "meta", "_journal.json"))) return c;
  }
  throw new Error("packages/db/drizzle not found from cwd " + process.cwd());
}

async function applyMigrations(dbUrl: string): Promise<void> {
  const client = new Pool({ connectionString: dbUrl, max: 1 });
  try {
    const dir = findDrizzleDir();
    const journal = JSON.parse(
      fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    for (const entry of journal.entries) {
      const statements = fs
        .readFileSync(path.join(dir, `${entry.tag}.sql`), "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) await client.query(stmt);
    }
  } finally {
    await client.end();
  }
}

interface Stack {
  pool: Pool;
  db: DrizzleDb;
  paymentRepo: DrizzlePaymentRepository;
  orderRepo: DrizzleOrderRepository;
  giftRepo: DrizzleGiftRepository;
  service: PaymentService;
}

function makeStack(dbUrl: string): Stack {
  const pool = new Pool({ connectionString: dbUrl, max: 5 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  return {
    pool,
    db,
    paymentRepo: new DrizzlePaymentRepository(db),
    orderRepo: new DrizzleOrderRepository(db),
    giftRepo: new DrizzleGiftRepository(db),
    service: new PaymentService(
      new DrizzlePaymentRepository(db),
      new DrizzleOrderRepository(db),
      new DrizzleGiftRepository(db),
    ),
  };
}

interface Fixture {
  userAId: string;
  restaurantId: string;
  menuItemId: string;
}

const TOTAL = 266.74;
const TOTAL_PAISE = Math.round(TOTAL * 100);

async function seedBase(stack: Stack): Promise<Fixture> {
  const userAId = randomUUID();
  const restaurantId = randomUUID();
  const menuItemId = randomUUID();
  await stack.db.execute(sql`
    INSERT INTO users (id, phone)
    VALUES (${userAId}, ${`+91${Math.floor(1e9 + Math.random() * 9e9)}`})
  `);
  await stack.db.execute(sql`
    INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license)
    VALUES (${restaurantId}, ${userAId}, 'IT Resto', 'GSTIT001', 'FSSAIIT001')
  `);
  await stack.db.execute(sql`
    INSERT INTO menu_items (id, restaurant_id, name, price)
    VALUES (${menuItemId}, ${restaurantId}, 'Biryani', ${"242.80"})
  `);
  return { userAId, restaurantId, menuItemId };
}

async function createDraftOrder(stack: Stack, fx: Fixture): Promise<OrderDTO> {
  return stack.orderRepo.create({
    user_id: fx.userAId,
    restaurant_id: fx.restaurantId,
    items: [
      {
        menu_item_id: fx.menuItemId,
        name: "Biryani",
        base_price: 242.8,
        quantity: 1,
        customizations: [],
        customization_total: 0,
        item_subtotal: 242.8,
        gift_id: null,
      },
    ],
    breakdown: {
      items: [
        {
          menu_item_id: fx.menuItemId,
          name: "Biryani",
          base_price: 242.8,
          quantity: 1,
          customizations: [],
          customization_total: 0,
          item_subtotal: 242.8,
        },
      ],
      food_subtotal: 242.8,
      packaging_fee: 10,
      packaging_fee_per_item: 10,
      gst_food: 12.14,
      gst_packaging: 1.8,
      total_amount: TOTAL,
      commission_rate: 0,
      commission_amount: 0,
    },
  });
}

async function createGift(stack: Stack, fx: Fixture, tag: string) {
  return stack.giftRepo.create({
    sender_id: fx.userAId,
    restaurant_id: fx.restaurantId,
    menu_item_id: fx.menuItemId,
    item_snapshot: {
      name: "Biryani",
      price: 242.8,
      image_url: null,
      dietary_tags: {},
      spice_level: 3,
      customizations: [],
    },
    price_paid: 30,
    message: `it-${tag}`,
    recipient_name: "Bob",
    claim_token: randomUUID(),
    claim_code: `IT${Math.floor(100000 + Math.random() * 900000)}`,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

let dbName = "";
let adminPool: Pool | null = null;
let stackA: Stack | null = null;
let stackB: Stack | null = null;
let fx: Fixture | null = null;

const emitted: string[] = [];

function errCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

async function probePostgres(): Promise<boolean> {
  const probe = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

const pgAvailable = await probePostgres();

describe.skipIf(!pgAvailable)("payments real-Postgres multi-instance integration", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ADMIN_URL, max: 2 });
    dbName = `snakzap_it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const dbUrl = `postgresql://snakzap:snakzap_test_pw@127.0.0.1:5432/${dbName}`;
    await applyMigrations(dbUrl);
    stackA = makeStack(dbUrl);
    stackB = makeStack(dbUrl);
    fx = await seedBase(stackA);

    onEvent("CashOnPickupSelected" as EventName, async (e) => {
      emitted.push(`CashOnPickupSelected:${e.aggregate_id}`);
    });
  });

  afterAll(async () => {
    razorpayService._resetTestState();
    if (stackA) await stackA.pool.end().catch(() => undefined);
    if (stackB) await stackB.pool.end().catch(() => undefined);
    if (adminPool && dbName) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } catch {
        // best-effort cleanup only
      }
      await adminPool.end().catch(() => undefined);
    }
  });

  beforeEach(() => {
    razorpayService._resetTestState();
    emitted.length = 0;
  });

  it("a) first-create race mints at most one provider order (single intent row)", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    const [ra, rb] = await Promise.all([
      stackA!.service.createPaymentOrder(order.id, fx!.userAId, "upi"),
      stackB!.service.createPaymentOrder(order.id, fx!.userAId, "upi"),
    ]);
    expect(ra.payment_id).toBe(rb.payment_id);
    expect(razorpayService.createOrderCount).toBe(1);
    const rows = await stackA!.db.execute(
      sql`SELECT id, provider_transaction_id, status FROM payments WHERE order_id = ${order.id}`,
    );
    const arr = (
      (rows as { rows?: Record<string, unknown>[] }).rows ?? (rows as Record<string, unknown>[])
    ) as { id: string; provider_transaction_id: string | null; status: string }[];
    expect(arr.length).toBe(1);
    expect(arr[0]!.provider_transaction_id).not.toBeNull();
    expect((await stackA!.orderRepo.getById(order.id))?.status).toBe("PAYMENT_PENDING");
  });

  it("b) second instance's reservation hits 23505 and reuses the winner intent", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    await stackA!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    // Fresh reservation attempt from the OTHER instance is rejected by the
    // partial unique index (preflight guarantees this was 0 at migration).
    await expect(
      stackB!.paymentRepo.createReservation({
        order_id: order.id,
        amount: TOTAL,
        receipt: "pay_dup_reservation",
        lease_owner: "instance-B",
      }),
    ).rejects.toMatchObject({ name: "PaymentTargetConflictError" });
    const winner = await stackB!.paymentRepo.getByOrderId(order.id);
    expect(winner).not.toBeNull();
    expect(winner!.razorpay_order_id).not.toBeNull();
    // A retry from instance B reuses the SAME intent and provider order.
    const retry = await stackB!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    expect(retry.payment_id).toBe(winner!.id);
    expect(retry.razorpay_order_id).toBe(winner!.razorpay_order_id);
    expect(razorpayService.createOrderCount).toBe(1);
  });

  it("c) lease held by another instance -> 202 IN_PROGRESS, no gateway order minted", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    // Instance A reserves and holds the lease with a long TTL (crash simulation).
    const intent = await stackA!.paymentRepo.createReservation({
      order_id: order.id,
      amount: TOTAL,
      receipt: "pay_seed_lease_held",
      lease_owner: "instance-A",
      leaseTtlMs: 60_000,
    });
    const res = await stackB!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    expect(res.payment_state).toBe("IN_PROGRESS");
    expect(res.razorpay_order_id).toBeUndefined();
    expect(res.retryable).toBe(true);
    expect(razorpayService.createOrderCount).toBe(0);
    expect(intent.razorpay_order_id).toBeNull();
  });

  it("d) expired-lease takeover by another instance reuses the SAME receipt", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    await stackA!.paymentRepo.createReservation({
      order_id: order.id,
      amount: TOTAL,
      receipt: "pay_seed_takeover",
      lease_owner: "instance-A",
      leaseTtlMs: -1000,
    });
    const res = await stackB!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    expect(res.payment_state).toBe("READY");
    expect(res.razorpay_order_id).toMatch(/^order_mock_/);
    expect(razorpayService.createOrderCount).toBe(1);
    const again = await stackA!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    expect(again.razorpay_order_id).toBe(res.razorpay_order_id);
    expect(razorpayService.createOrderCount).toBe(1);
  });

  it("e) ambiguous provider state reconciled by exact receipt (never a duplicate order)", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    // Crash AFTER the provider order was created but BEFORE DB finalize.
    const preExisting = await razorpayService.createOrder(TOTAL_PAISE, "pay_seed_ambig");
    await stackA!.paymentRepo.createReservation({
      order_id: order.id,
      amount: TOTAL,
      receipt: "pay_seed_ambig",
      lease_owner: "instance-A",
      leaseTtlMs: -1000,
    });
    const res = await stackB!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    expect(res.payment_state).toBe("READY");
    expect(res.razorpay_order_id).toBe(preExisting.id);
    expect(razorpayService.createOrderCount).toBe(1);
  });

  it("f) mixed ONLINE vs COD race: exactly one wins, the other gets PAYMENT_METHOD_CONFLICT", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    const results = await Promise.allSettled([
      stackA!.service.createPaymentOrder(order.id, fx!.userAId, "upi"),
      stackB!.service.createPaymentOrder(order.id, fx!.userAId, "cod"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(errCode(rejected[0]!.reason)).toBe("PAYMENT_METHOD_CONFLICT");

    const winner = (
      fulfilled[0] as PromiseFulfilledResult<PaymentInitiationResult> | undefined
    )!.value;
    const payment = (await stackA!.paymentRepo.getByOrderId(order.id)) as PaymentDTO;
    const orderNow = (await stackA!.orderRepo.getById(order.id)) as OrderDTO;
    if (winner.payment_method === "cod") {
      expect(payment.method).toBe("cod");
      expect(payment.razorpay_order_id).toMatch(/^cod_/);
      expect(orderNow.status).toBe("CONFIRMED");
      expect(razorpayService.createOrderCount).toBe(0);
      // The COD winner emits exactly one CashOnPickupSelected event.
      expect(emitted.filter((e) => e.endsWith(order.id)).length).toBe(1);
    } else {
      expect(payment.method).toBeNull();
      expect(payment.razorpay_order_id).toMatch(/^order_mock_/);
      expect(orderNow.status).toBe("PAYMENT_PENDING");
      expect(razorpayService.createOrderCount).toBe(1);
    }
  });

  it("g) late payment.failed never downgrades a captured payment (monotonic)", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    const created = await stackA!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    const captured = razorpayService.buildMockWebhook(
      created.razorpay_order_id!,
      TOTAL_PAISE,
      "payment.captured",
    );
    const first = await stackB!.service.processWebhook(captured.rawBody, captured.signature);
    expect(first.orderStatus).toBe("CONFIRMED");

    const lateFailed = razorpayService.buildMockWebhook(
      created.razorpay_order_id!,
      TOTAL_PAISE,
      "payment.failed",
    );
    const late = await stackA!.service.processWebhook(lateFailed.rawBody, lateFailed.signature);
    expect(late.idempotent).toBe(true);

    const payment = (await stackA!.paymentRepo.getByOrderId(order.id)) as PaymentDTO;
    expect(payment.status).toBe("CAPTURED");
    expect((await stackA!.orderRepo.getById(order.id))?.status).toBe("CONFIRMED");
  });

  it("h) retry after FAILED payment reuses the SAME provider order (createOrderCount stays 1)", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    const created = await stackA!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    const failed = razorpayService.buildMockWebhook(
      created.razorpay_order_id!,
      TOTAL_PAISE,
      "payment.failed",
    );
    const res = await stackB!.service.processWebhook(failed.rawBody, failed.signature);
    expect(res.orderStatus).toBe("PAYMENT_FAILED");
    expect((await stackA!.orderRepo.getById(order.id))?.status).toBe("PAYMENT_FAILED");

    const retry = await stackB!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    expect(retry.payment_state).toBe("READY");
    expect(retry.razorpay_order_id).toBe(created.razorpay_order_id);
    expect(razorpayService.createOrderCount).toBe(1);
    expect((await stackA!.orderRepo.getById(order.id))?.status).toBe("PAYMENT_PENDING");
  });

  it("i) receipt+amount+currency mismatch -> AMBIGUOUS_RECEIPT, never a new order", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    // Gateway down: the intent lands in FAILED_INITIATION and keeps its receipt.
    razorpayService._simulateCreateOrderError(new Error("gateway down"));
    await expect(
      stackA!.service.createPaymentOrder(order.id, fx!.userAId, "upi"),
    ).rejects.toThrow("gateway down");
    razorpayService._simulateCreateOrderError(null);

    const intent = (await stackA!.paymentRepo.getByOrderId(order.id)) as PaymentDTO;
    expect(intent.status).toBe("FAILED_INITIATION");
    // A provider order exists for the SAME receipt but a WRONG amount.
    await razorpayService.createOrder(TOTAL_PAISE + 1, intent.receipt);

    await expect(
      stackB!.service.createPaymentOrder(order.id, fx!.userAId, "upi"),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_RECEIPT" });
    expect(razorpayService.createOrderCount).toBe(1);
    const after = (await stackA!.paymentRepo.getByOrderId(order.id)) as PaymentDTO;
    expect(after.status).toBe("FAILED_INITIATION");
    expect(after.razorpay_order_id).toBeNull();
  });

  it("j) concurrent attempts[] appends from both instances lose no entries", async () => {
    const order = await createDraftOrder(stackA!, fx!);
    const created = await stackA!.service.createPaymentOrder(order.id, fx!.userAId, "upi");
    const intent = (await stackA!.paymentRepo.getByOrderId(order.id)) as PaymentDTO;

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        (i % 2 === 0 ? stackA! : stackB!).paymentRepo.appendAttempt(intent.id, {
          event: `probe_${i}`,
          reason: `instance-${i % 2 === 0 ? "A" : "B"}`,
        }),
      ),
    );
    const final = (await stackA!.paymentRepo.getByOrderId(order.id)) as PaymentDTO;
    const attempts = final.attempts;
    // 1 initiation_started + 1 provider_order_created (from the finalize) + 5
    // concurrent appends across both instances = 7, none lost.
    expect(attempts.length).toBe(7);
    const seqs = attempts.map((a) => a.seq).sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(attempts.map((a) => a.event)).size).toBe(7);
    expect(created.razorpay_order_id).toBe(final.razorpay_order_id);
  });

  it("k) gift end-to-end across instances: retry reuse + capture activates the gift", async () => {
    const gift = await createGift(stackA!, fx!, "e2e");
    const created = await stackA!.service.createGiftPayment(gift.id, fx!.userAId);
    expect(created.payment_state).toBe("READY");
    expect(razorpayService.createOrderCount).toBe(1);

    const again = await stackB!.service.createGiftPayment(gift.id, fx!.userAId);
    expect(again.payment_id).toBe(created.payment_id);
    expect(again.razorpay_order_id).toBe(created.razorpay_order_id);
    expect(razorpayService.createOrderCount).toBe(1);

    const captured = razorpayService.buildMockWebhook(
      created.razorpay_order_id!,
      3000,
      "payment.captured",
    );
    const processed = await stackB!.service.processWebhook(captured.rawBody, captured.signature);
    expect(processed.giftStatus).toBe("ACTIVE");
    expect((await stackA!.giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
    const payment = (await stackA!.paymentRepo.getByGiftId(gift.id)) as PaymentDTO;
    expect(payment.status).toBe("CAPTURED");
  });
});
