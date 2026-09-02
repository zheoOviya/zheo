// ============================================================
// DINE-OPS1.3-PG1 — VENDOR DINE-IN ORDER WRITE ROUTES (real PG).
//
// NOT part of the memory-mode unit suite. Route-level HTTP proof of
// the accepted vendor write wrappers (vendorOps.ts dine-in advance /
// cancel) mounted under requireVendorOrAdmin, exercised through the
// real Express app (createApp) against a REAL PostgreSQL database:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgVendorDineInWrite.ts
//
// PROVES (and only claims):
//   (1) cross-restaurant vendor ADVANCE is refused: HTTP 403 FORBIDDEN and
//       the persisted row status is still PLACED (auth-before-mutation).
//   (2) same cross-restaurant CANCEL is refused: 403 FORBIDDEN, unchanged.
//   (3) the authorized owner advances PLACED -> PREPARING ->
//       READY_TO_SERVE -> SERVED; every step is HTTP 200 and every state is
//       read back from the real row.
//   (4) the SERVED row carries a server-generated served_at (NOT NULL).
//   (5) a separate PLACED order CANCEL -> CANCELLED with persisted
//       cancelled_by = authenticated vendor user id and non-null
//       cancelled_at.
//   (6) body/query restaurant_id spoof does NOT change authorization or
//       state (restaurant_id is derived from the persisted order only).
//   (7) an unknown order UUID is 404 ORDER_NOT_FOUND with zero unrelated
//       mutation.
//   (8) no idle-in-transaction sessions remain after the run.
//   (9) frozen DineInOrderService semantics are untouched (route wrapper
//       harness only; no source change here).
//
// BOUNDARIES: route + RBAC + middleware only. No source changes beyond the
// accepted vendorOps.ts wrappers, no schema/migration, no auth changes, no
// D-PAY, no commit. Disposable dining fixture is removed on exit.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import request from "supertest";
import { createApp } from "../src/app";
import { jwtService } from "../src/services/jwt";

const maybeUrl = process.env.DATABASE_URL;
if (!maybeUrl) {
  console.error("FATAL: DATABASE_URL is required (must point at the disposable I-track DB)");
  process.exit(2);
}
const url: string = maybeUrl;
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV (createDb() rejects test mode)");
  process.exit(2);
}

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `ASSERT FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  console.log(`  ASSERT OK [${label}]: ${JSON.stringify(actual)}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAIL [${label}]`);
  console.log(`  ASSERT OK [${label}]: true`);
}

async function countIdleInTransaction(pool: Pool): Promise<number> {
  const rows = (await pool.query(
    `SELECT count(*)::int AS c FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle in transaction'`,
  )).rows as { c: number }[];
  return rows[0]?.c ?? -1;
}

interface OrderRowState {
  status: string;
  served_at: Date | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
}

async function readOrderState(pool: Pool, id: string): Promise<OrderRowState> {
  const rows = (await pool.query(
    `SELECT status, served_at, cancelled_by, cancelled_at
       FROM dine_in_orders WHERE id = $1`,
    [id],
  )).rows as OrderRowState[];
  if (rows.length !== 1) {
    throw new Error(`FIXTURE INVARIANT FAIL: expected exactly 1 order row for ${id}, got ${rows.length}`);
  }
  return rows[0];
}

function bearerToken(claims: {
  sub: string;
  role: string;
  phone: string;
}): string {
  return jwtService.signAccessToken({
    sub: claims.sub,
    role: claims.role,
    phone: claims.phone,
    device_fingerprint: "fp_pg_proof_ops13_device_0001",
  });
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const app = createApp();

  const pool = new Pool({ connectionString: url, application_name: "itrackOps1_3" });
  const setup = drizzle(pool);

  const idleBefore = await countIdleInTransaction(pool);
  console.log(`IDLE-IN-TRANSACTION (before): ${idleBefore} (expect 0)`);
  assertEqual(idleBefore, 0, "idle-in-transaction before (expect 0)");

  const ownerAId = randomUUID();
  const ownerBId = randomUUID();
  const guestId = randomUUID();
  const restaurantAId = randomUUID();
  const restaurantBId = randomUUID();
  const tableAId = randomUUID();
  const tableBId = randomUUID();
  const sessionAId = randomUUID();
  const sessionBId = randomUUID();
  const orderAdvanceAId = randomUUID(); // owner A advances PLACED->...->SERVED
  const orderCancelAId = randomUUID(); // owner A cancels PLACED -> CANCELLED
  const orderAttackAId = randomUUID(); // owner B cross-restaurant target, stays PLACED
  const orderAdvanceBId = randomUUID(); // owner B's own order (scope control)
  const unknownOrderId = randomUUID();

  const tokenA = bearerToken({ sub: ownerAId, role: "VENDOR_OWNER", phone: `ops13-ownerA-${randomUUID()}` });
  const tokenB = bearerToken({ sub: ownerBId, role: "VENDOR_OWNER", phone: `ops13-ownerB-${randomUUID()}` });

  async function httpPost(
    path: string,
    token: string,
    body?: Record<string, unknown>,
  ) {
    let r = request(app)
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json");
    if (body !== undefined) r = r.send(body);
    return r;
  }

  let seeded = false;
  try {
    const safety = (await pool.query(
      "SELECT current_database() AS db, current_user AS usr",
    )).rows[0] as { db: string; usr: string };
    if (safety.db !== "dine_itrack" || safety.usr !== "dine_itrack") {
      throw new Error(
        `SAFETY REFUSED: expected dine_itrack/dine_itrack, got ${safety.db}/${safety.usr}.`,
      );
    }
    console.log(`SAFETY OK: ${safety.db}/${safety.usr}`);

    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerAId}, ${`ops13-ownerA-${randomUUID()}`})`,
    );
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerBId}, ${`ops13-ownerB-${randomUUID()}`})`,
    );
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${guestId}, ${`ops13-guest-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantAId}, ${ownerAId}, ${`Ops1.3-A-${randomUUID().slice(0, 8)}`}, ${`GST13A${randomUUID().replace(/-/g, "").slice(0, 10)}`}, ${`FSSAI13A${randomUUID().replace(/-/g, "").slice(0, 10)}`}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantBId}, ${ownerBId}, ${`Ops1.3-B-${randomUUID().slice(0, 8)}`}, ${`GST13B${randomUUID().replace(/-/g, "").slice(0, 10)}`}, ${`FSSAI13B${randomUUID().replace(/-/g, "").slice(0, 10)}`}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token, is_active)
      VALUES (${tableAId}, ${restaurantAId}, ${"T-A1"}, ${`ops13-token-A-${randomUUID().replace(/-/g, "")}`}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token, is_active)
      VALUES (${tableBId}, ${restaurantBId}, ${"T-B1"}, ${`ops13-token-B-${randomUUID().replace(/-/g, "")}`}, true)
    `);
    await setup.execute(sql`
      INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status)
      VALUES (${sessionAId}, ${restaurantAId}, ${tableAId}, ${guestId}, 'ACTIVE')
    `);
    await setup.execute(sql`
      INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status)
      VALUES (${sessionBId}, ${restaurantBId}, ${tableBId}, ${guestId}, 'ACTIVE')
    `);
    const mkOrder = (id: string, restaurantId: string, sessionId: string, createdAt: string) =>
      setup.execute(sql`
        INSERT INTO dine_in_orders (id, session_id, restaurant_id, placed_by, status, total_amount, created_at, updated_at)
        VALUES (${id}, ${sessionId}, ${restaurantId}, ${guestId}, 'PLACED', 462.00, ${createdAt}, ${createdAt})
      `);
    await mkOrder(orderAdvanceAId, restaurantAId, sessionAId, "2026-08-24T10:01:00.000Z");
    await mkOrder(orderCancelAId, restaurantAId, sessionAId, "2026-08-24T10:02:00.000Z");
    await mkOrder(orderAttackAId, restaurantAId, sessionAId, "2026-08-24T10:03:00.000Z");
    await mkOrder(orderAdvanceBId, restaurantBId, sessionBId, "2026-08-24T10:04:00.000Z");
    seeded = true;
    console.log("FIXTURE OK: restA (ownerA) 3x PLACED orders + restB (ownerB) 1x PLACED order");

    // ---- (1) cross-restaurant vendor ADVANCE is refused, row unchanged ----
    console.log("\n--- PROOF (1): owner B ADVANCE on restaurant A order => 403, still PLACED ---");
    const r1 = await httpPost(`/api/vendor/dine-in/orders/${orderAttackAId}/advance`, tokenB, {
      target_status: "PREPARING",
    });
    console.log(`HTTP ${r1.status} body.error=${JSON.stringify((r1.body as any).error)}`);
    assertEqual(r1.status, 403, "cross-restaurant advance status");
    assertEqual((r1.body as any).error?.code, "FORBIDDEN", "cross-restaurant advance error code");
    let st = await readOrderState(pool, orderAttackAId);
    console.log(`ROW orderAttackA: status=${st.status}, served_at=${st.served_at}, cancelled_by=${st.cancelled_by}, cancelled_at=${st.cancelled_at}`);
    assertEqual(st.status, "PLACED", "cross-restaurant advance leaves row PLACED");

    // ---- (2) same cross-restaurant CANCEL is refused, row unchanged ----
    console.log("\n--- PROOF (2): owner B CANCEL on restaurant A order => 403, still PLACED ---");
    const r2 = await httpPost(`/api/vendor/dine-in/orders/${orderAttackAId}/cancel`, tokenB);
    console.log(`HTTP ${r2.status} body.error=${JSON.stringify((r2.body as any).error)}`);
    assertEqual(r2.status, 403, "cross-restaurant cancel status");
    assertEqual((r2.body as any).error?.code, "FORBIDDEN", "cross-restaurant cancel error code");
    st = await readOrderState(pool, orderAttackAId);
    console.log(`ROW orderAttackA: status=${st.status}, served_at=${st.served_at}, cancelled_by=${st.cancelled_by}, cancelled_at=${st.cancelled_at}`);
    assertEqual(st.status, "PLACED", "cross-restaurant cancel leaves row PLACED");

    // ---- (6) body/query restaurant_id spoof changes nothing ----
    console.log("\n--- PROOF (6): restaurant_id spoof (body+query) => still 403, still PLACED ---");
    const r3 = await httpPost(
      `/api/vendor/dine-in/orders/${orderAttackAId}/advance?restaurant_id=${restaurantBId}`,
      tokenB,
      { target_status: "PREPARING", restaurant_id: restaurantBId },
    );
    console.log(`HTTP ${r3.status} body.error=${JSON.stringify((r3.body as any).error)}`);
    assertEqual(r3.status, 403, "spoofed advance status");
    assertEqual((r3.body as any).error?.code, "FORBIDDEN", "spoofed advance error code");
    const r4 = await httpPost(
      `/api/vendor/dine-in/orders/${orderAttackAId}/cancel?restaurant_id=${restaurantBId}`,
      tokenB,
      { restaurant_id: restaurantBId },
    );
    console.log(`HTTP ${r4.status} body.error=${JSON.stringify((r4.body as any).error)}`);
    assertEqual(r4.status, 403, "spoofed cancel status");
    assertEqual((r4.body as any).error?.code, "FORBIDDEN", "spoofed cancel error code");
    st = await readOrderState(pool, orderAttackAId);
    console.log(`ROW orderAttackA: status=${st.status}, served_at=${st.served_at}, cancelled_by=${st.cancelled_by}, cancelled_at=${st.cancelled_at}`);
    assertEqual(st.status, "PLACED", "spoof leaves row PLACED");
    assertTrue(st.served_at === null && st.cancelled_by === null && st.cancelled_at === null,
      "spoof leaves no audit/status metadata on the row");

    // ---- (3)+(4) authorized owner advances the whole chain; each state persisted ----
    console.log("\n--- PROOF (3)+(4): owner A advance chain PLACED->PREPARING->READY_TO_SERVE->SERVED ---");
    const a1 = await httpPost(`/api/vendor/dine-in/orders/${orderAdvanceAId}/advance`, tokenA, {
      target_status: "PREPARING",
    });
    console.log(`HTTP ${a1.status} body.data.order.status=${(a1.body as any).data?.order?.status}`);
    assertEqual(a1.status, 200, "advance -> PREPARING http status");
    assertEqual((a1.body as any).data?.order?.status, "PREPARING", "advance -> PREPARING response status");
    st = await readOrderState(pool, orderAdvanceAId);
    console.log(`ROW orderAdvanceA: status=${st.status}`);
    assertEqual(st.status, "PREPARING", "advance -> PREPARING persisted");

    const a2 = await httpPost(`/api/vendor/dine-in/orders/${orderAdvanceAId}/advance`, tokenA, {
      target_status: "READY_TO_SERVE",
    });
    console.log(`HTTP ${a2.status} body.data.order.status=${(a2.body as any).data?.order?.status}`);
    assertEqual(a2.status, 200, "advance -> READY_TO_SERVE http status");
    assertEqual((a2.body as any).data?.order?.status, "READY_TO_SERVE", "advance -> READY_TO_SERVE response status");
    st = await readOrderState(pool, orderAdvanceAId);
    console.log(`ROW orderAdvanceA: status=${st.status}`);
    assertEqual(st.status, "READY_TO_SERVE", "advance -> READY_TO_SERVE persisted");

    const a3 = await httpPost(`/api/vendor/dine-in/orders/${orderAdvanceAId}/advance`, tokenA, {
      target_status: "SERVED",
    });
    console.log(`HTTP ${a3.status} body.data.order.status=${(a3.body as any).data?.order?.status} served_at=${(a3.body as any).data?.order?.served_at}`);
    assertEqual(a3.status, 200, "advance -> SERVED http status");
    assertEqual((a3.body as any).data?.order?.status, "SERVED", "advance -> SERVED response status");
    assertTrue(typeof (a3.body as any).data?.order?.served_at === "string" && (a3.body as any).data?.order?.served_at.length > 0,
      "SERVED response carries non-empty served_at");
    st = await readOrderState(pool, orderAdvanceAId);
    console.log(`ROW orderAdvanceA: status=${st.status}, served_at=${st.served_at}`);
    assertEqual(st.status, "SERVED", "advance -> SERVED persisted");
    assertTrue(st.served_at !== null, "SERVED row has server-generated served_at (NOT NULL)");

    // ---- (5) separate PLACED order cancel => CANCELLED with audit metadata ----
    console.log("\n--- PROOF (5): owner A CANCEL PLACED order => CANCELLED + cancelled_by/cancelled_at ---");
    const c1 = await httpPost(`/api/vendor/dine-in/orders/${orderCancelAId}/cancel`, tokenA);
    console.log(`HTTP ${c1.status} body.data.order.status=${(c1.body as any).data?.order?.status} cancelled_by=${(c1.body as any).data?.order?.cancelled_by} cancelled_at=${(c1.body as any).data?.order?.cancelled_at}`);
    assertEqual(c1.status, 200, "cancel http status");
    assertEqual((c1.body as any).data?.order?.status, "CANCELLED", "cancel response status");
    assertTrue(typeof (c1.body as any).data?.order?.cancelled_at === "string" && (c1.body as any).data?.order?.cancelled_at.length > 0,
      "cancel response carries non-empty cancelled_at");
    assertEqual((c1.body as any).data?.order?.cancelled_by, ownerAId, "cancel response cancelled_by is the authenticated vendor user");
    st = await readOrderState(pool, orderCancelAId);
    console.log(`ROW orderCancelA: status=${st.status}, cancelled_by=${st.cancelled_by}, cancelled_at=${st.cancelled_at}`);
    assertEqual(st.status, "CANCELLED", "cancel persisted CANCELLED");
    assertTrue(st.cancelled_at !== null, "cancel row has non-null cancelled_at");
    assertEqual(st.cancelled_by, ownerAId, "cancel row cancelled_by == authenticated vendor user id");

    // ---- control: owner B CAN legitimately advance its OWN order (scope, not capability) ----
    console.log("\n--- CONTROL: owner B advances OWN order PLACED->PREPARING => 200 (scope proof) ---");
    const b1 = await httpPost(`/api/vendor/dine-in/orders/${orderAdvanceBId}/advance`, tokenB, {
      target_status: "PREPARING",
    });
    console.log(`HTTP ${b1.status} body.data.order.status=${(b1.body as any).data?.order?.status}`);
    assertEqual(b1.status, 200, "owner B own-order advance http status");
    assertEqual((b1.body as any).data?.order?.status, "PREPARING", "owner B own-order advance response status");
    st = await readOrderState(pool, orderAdvanceBId);
    console.log(`ROW orderAdvanceB: status=${st.status}`);
    assertEqual(st.status, "PREPARING", "owner B own-order advance persisted");

    // ---- (7) unknown order UUID => 404 ORDER_NOT_FOUND, no unrelated mutation ----
    console.log("\n--- PROOF (7): unknown order UUID => 404 ORDER_NOT_FOUND, no unrelated mutation ---");
    const countBefore = ((await pool.query(
      `SELECT count(*)::int AS c FROM dine_in_orders WHERE restaurant_id IN ($1, $2)`,
      [restaurantAId, restaurantBId],
    )).rows as { c: number }[])[0].c;
    const u1 = await httpPost(`/api/vendor/dine-in/orders/${unknownOrderId}/advance`, tokenA, {
      target_status: "PREPARING",
    });
    console.log(`HTTP ${u1.status} body.error=${JSON.stringify((u1.body as any).error)}`);
    assertEqual(u1.status, 404, "unknown advance http status");
    assertEqual((u1.body as any).error?.code, "ORDER_NOT_FOUND", "unknown advance error code");
    const u2 = await httpPost(`/api/vendor/dine-in/orders/${unknownOrderId}/cancel`, tokenA);
    console.log(`HTTP ${u2.status} body.error=${JSON.stringify((u2.body as any).error)}`);
    assertEqual(u2.status, 404, "unknown cancel http status");
    assertEqual((u2.body as any).error?.code, "ORDER_NOT_FOUND", "unknown cancel error code");
    const countAfter = ((await pool.query(
      `SELECT count(*)::int AS c FROM dine_in_orders WHERE restaurant_id IN ($1, $2)`,
      [restaurantAId, restaurantBId],
    )).rows as { c: number }[])[0].c;
    assertEqual(countAfter, countBefore, "unknown-order 404 causes zero order-row drift");
    st = await readOrderState(pool, orderAttackAId);
    console.log(`ROW orderAttackA (post-404): status=${st.status}`);
    assertEqual(st.status, "PLACED", "orderAttackA untouched by unknown-order 404s");

    // ---- (8) no idle-in-transaction left behind ----
    console.log("\n--- PROOF (8): idle-in-transaction after ---");
    const idleAfter = await countIdleInTransaction(pool);
    console.log(`IDLE-IN-TRANSACTION (after): ${idleAfter} (expect 0)`);
    assertEqual(idleAfter, 0, "idle-in-transaction after (expect 0)");

    console.log("\nALL PROOF ASSERTIONS PASSED");
  } finally {
    if (seeded) {
      for (const id of [orderAdvanceAId, orderCancelAId, orderAttackAId, orderAdvanceBId]) {
        await pool.query("DELETE FROM dine_in_orders WHERE id = $1", [id]);
      }
      for (const id of [sessionAId, sessionBId]) {
        await pool.query("DELETE FROM dining_sessions WHERE id = $1", [id]);
      }
      for (const id of [tableAId, tableBId]) {
        await pool.query("DELETE FROM restaurant_tables WHERE id = $1", [id]);
      }
      for (const id of [restaurantAId, restaurantBId]) {
        await pool.query("DELETE FROM restaurants WHERE id = $1", [id]);
      }
      for (const id of [ownerAId, ownerBId, guestId]) {
        await pool.query("DELETE FROM users WHERE id = $1", [id]);
      }
      console.log("CLEANUP OK: fixture removed");
    }
    await pool.end();
  }
}

main()
  .then(() => {
    console.log("\nVERDICT: DINE_OPS1_3_PG1_ACCEPTED");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("\nVERDICT: DINE_OPS1_3_PG1_REPAIR_REQUIRED");
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
