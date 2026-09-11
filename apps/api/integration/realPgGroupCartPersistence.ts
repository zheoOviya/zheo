// ============================================================
// GROUP-CART-PG-DURABILITY-A2 - REAL-POSTGRES DURABILITY PROOF (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV against a disposable, already-migrated DATABASE_URL (migration
// 0016_group_cart_persistence.sql must have been applied):
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://a2_support_proof:<pw>@127.0.0.1:5432/a2_support_proof \
//   pnpm exec tsx apps/api/integration/realPgGroupCartPersistence.ts
//
// PROVES (and only claims):
//   (1) both group-cart tables exist after migration 0016.
//   (2) constraint semantics: contributor->cart FK CASCADEs; order/restaurant/
//       created_by/user FKs are NO ACTION; the member uniqueness index exists.
//   (3) create persists the cart row + the host contributor.
//   (4) an independent connection reads the cart; unknown tokens return null.
//   (5) a distinct contributor is stored as a separate row.
//   (6) a repeat add by the same user APPENDS items (no lost lines) while
//       preserving display_name/avatar_seed and refreshing added_at.
//   (7) all state survives closing the pool and rebuilding repos over a fresh
//       connection (durability across restart, 3 epochs).
//   (8) atomic rollback: a failing attribution write rolls back the order
//       setItems in the SAME transaction.
//   (9) token PK collision (23505 group_carts_pkey) rolls back the WHOLE tx,
//       and isClassTokenCollision distinguishes it -> Strategy A is sound.
//  (10) order_id is unique: a second cart for the same order is rejected.
//  (11) concurrent DISTINCT-user adds serialize on the cart row lock and all
//       persist (no lost order lines).
//  (12) concurrent SAME-user adds append atomically into exactly one row.
//  (13) [A2R2] different carts do NOT block each other: cart B's full mutation
//       commits while cart A's row lock is deliberately held open (per-cart,
//       not global/table-level, serialization).
//  (14) [A2R2] the REAL GroupOrderService.createGroupCart bounded retry loop:
//       attempt 1 hits a real group_carts PK 23505 and its whole tx rolls back,
//       attempt 2 succeeds with the fresh token, exactly one DRAFT order
//       survives, and the host contributor exists.
//  (15) [A2R2] persistent collision exhausts the frozen <=3 bound, returns the
//       stable 500-class GROUP_CART_CREATE_FAILED, and leaks zero orphan orders.
//
//  M1: point 8 asserts the rollback trigger is specifically PG SQLSTATE 23503.
//  M3: point 6 asserts group_carts.updated_at advances on a contribution.
//
// Memory-parity alone is not a durability proof; this harness talks to the
// real tables through real connection pools. Disposable rows are left in the
// disposable DB by design (no destructive cleanup).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { restaurants, menu_items, users } from "@snakzap/db";
import { DrizzleOrderRepository } from "../src/repositories/drizzle/drizzleOrderRepository";
import { DrizzleGroupCartRepository } from "../src/repositories/drizzle/drizzleGroupCartRepository";
import { DrizzleGroupOrderTransactionPort } from "../src/repositories/drizzle/groupOrderTransactionPort";
import { DrizzleIdentityRepository } from "../src/repositories/drizzle/drizzleIdentityRepository";
import { DrizzleCatalogRepository } from "../src/repositories/catalogRepository";
import { GroupOrderService, isGroupCartTokenCollision } from "../src/services/groupOrder";
import {
  calculatePriceBreakdown,
  type OrderItemInput,
  type PriceBreakdown,
} from "../src/services/pricing";
import type { DrizzleDb } from "../src/lib/dbType";
import type { OrderItemDTO } from "../src/repositories/orderRepository";
import type { GroupOrderTransactionPort } from "../src/repositories/groupCartRepository";

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

/** Walks the error cause chain to the Postgres SQLSTATE (e.g. "23503"). */
function pgErrorCode(err: unknown): string | undefined {
  let cur = err as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause as typeof cur;
  }
  return undefined;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms (deadlock guard)`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function countOrders(db: DrizzleDb, userId: string): Promise<number> {
  const rows = (
    await (db as unknown as RawDb).execute(
      sql`SELECT count(*)::int AS n FROM orders WHERE user_id = ${userId}`,
    )
  ).rows;
  return rows[0]!.n as number;
}

function dtoItems(inputs: OrderItemInput[], breakdown: PriceBreakdown): Omit<OrderItemDTO, "id">[] {
  return inputs.map((oi) => ({
    menu_item_id: oi.menu_item_id,
    name: oi.name,
    base_price: oi.base_price,
    quantity: oi.quantity,
    customizations: oi.customizations,
    gift_id: null,
    customization_total:
      breakdown.items.find((b) => b.menu_item_id === oi.menu_item_id)
        ?.customization_total ?? 0,
    item_subtotal:
      breakdown.items.find((b) => b.menu_item_id === oi.menu_item_id)
        ?.item_subtotal ?? 0,
  }));
}

interface Seed {
  owner_id: string;
  restaurant_id: string;
  menu_item_id: string;
  menu_item_name: string;
  menu_item_price: number;
}

async function seed(db: DrizzleDb, runTag: string): Promise<Seed> {
  const owner_id = randomUUID();
  const restaurant_id = randomUUID();
  const menu_item_id = randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id: owner_id,
    phone: `a2-gc-owner-${runTag}`,
    role: "VENDOR",
    created_at: now,
  });
  await db.insert(restaurants).values({
    id: restaurant_id,
    owner_id,
    name: `A2 GC Diner ${runTag}`,
    gst_number: `GST-${runTag}`,
    fssai_license: `FSSAI-${runTag}`,
    created_at: now,
  });
  await db.insert(menu_items).values({
    id: menu_item_id,
    restaurant_id,
    name: `A2 GC Item ${runTag}`,
    price: "120.00",
    created_at: now,
  });
  return { owner_id, restaurant_id, menu_item_id, menu_item_name: `A2 GC Item ${runTag}`, menu_item_price: 120 };
}

async function makeUser(db: DrizzleDb, label: string): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    phone: `a2-gc-${label}-${randomUUID()}`,
    role: "CONSUMER",
    created_at: new Date(),
  });
  return id;
}

/** Replicates the add-flow sequence used by GroupOrderService.addToGroupCart. */
async function addViaPort(
  port: GroupOrderTransactionPort,
  token: string,
  userId: string,
  displayName: string,
  avatarSeed: string,
  seed: Seed,
  quantity: number,
): Promise<void> {
  await port.runInTransaction(async ({ orders, carts }) => {
    const cart = await carts.lockByToken(token);
    assert(cart, `addViaPort: cart ${token} missing`);
    const order = await orders.getById(cart.order_id);
    assert(order, "addViaPort: order missing");
    assert(order.status === "DRAFT", "addViaPort: order not DRAFT");

    const inputs: OrderItemInput[] = [
      ...order.items.map((oi) => ({
        menu_item_id: oi.menu_item_id,
        name: oi.name,
        base_price: oi.base_price,
        quantity: oi.quantity,
        customizations: oi.customizations,
      })),
      {
        menu_item_id: seed.menu_item_id,
        name: seed.menu_item_name,
        base_price: seed.menu_item_price,
        quantity,
        customizations: [],
      },
    ];
    const breakdown = calculatePriceBreakdown(inputs);
    const updated = await orders.setItems(cart.order_id, dtoItems(inputs, breakdown), breakdown);
    assert(updated, "addViaPort: setItems returned null");
    await carts.addContribution(token, {
      user_id: userId,
      display_name: displayName,
      avatar_seed: avatarSeed,
      items: [
        {
          menu_item_id: seed.menu_item_id,
          name: seed.menu_item_name,
          quantity,
          price: seed.menu_item_price,
        },
      ],
    });
  });
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(dbUrl)}`);
  console.log("A2 real-PG group-cart durability proof starting...");
  const runTag = randomUUID().slice(0, 8);

  const poolA = new Pool({ connectionString: dbUrl, max: 8 });
  const dbA = makeDb(poolA);
  const rawA = dbA as unknown as RawDb;
  const seedData = await seed(dbA, runTag);
  try {
    const tables = (
      await rawA.execute(
        sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('group_carts','group_cart_contributors')`,
      )
    ).rows.map((r) => r.tablename as string);
    assert(
      tables.includes("group_carts") && tables.includes("group_cart_contributors"),
      `point1: missing tables (${tables.join(",")})`,
    );
    console.log(`[point1] tables present: ${tables.sort().join(", ")}`);

    const fks = (
      await rawA.execute(
        sql`SELECT tc.constraint_name, tc.table_name, rc.delete_rule FROM information_schema.table_constraints tc JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema WHERE tc.constraint_schema='public' AND tc.table_name IN ('group_carts','group_cart_contributors') AND tc.constraint_type='FOREIGN KEY'`,
      )
    ).rows;
    const ruleOf = (name: string): string | undefined =>
      fks.find((r) => r.constraint_name === name)?.delete_rule as string | undefined;
    assert(
      ruleOf("group_cart_contributors_group_cart_id_group_carts_token_fk") === "CASCADE",
      "point2: contributor->cart FK is not CASCADE",
    );
    assert(
      ruleOf("group_carts_order_id_orders_id_fk") === "NO ACTION",
      "point2: cart->order FK is not NO ACTION",
    );
    assert(
      ruleOf("group_carts_restaurant_id_restaurants_id_fk") === "NO ACTION",
      "point2: cart->restaurant FK is not NO ACTION",
    );
    assert(
      ruleOf("group_carts_created_by_users_id_fk") === "NO ACTION",
      "point2: cart->created_by FK is not NO ACTION",
    );
    const uq = (
      await rawA.execute(
        sql`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='group_cart_contributors' AND indexname='group_cart_contributors_member_uq'`,
      )
    ).rows;
    assert(uq.length === 1, "point2: member uniqueness index missing");
    console.log("[point2] FK delete rules + member uniqueness index verified");

    const portA = new DrizzleGroupOrderTransactionPort(dbA);
    const cartsRepoA = new DrizzleGroupCartRepository(dbA);

    // ---------- Point 3: create persists cart + host ----------
    const host = await makeUser(dbA, "host");
    const token = `gc_${runTag}_main`;
    const created = await portA.runInTransaction(async ({ orders, carts }) => {
      const order = await orders.create({
        user_id: host,
        restaurant_id: seedData.restaurant_id,
        items: [],
        breakdown: calculatePriceBreakdown([]),
      });
      const cart = await carts.create({
        token,
        order_id: order.id,
        restaurant_id: seedData.restaurant_id,
        created_by: host,
      });
      return { order, cart };
    });
    assert(created.cart.token === token, "point3: token mismatch");
    assert(created.cart.contributors.length === 1, "point3: expected 1 host contributor");
    assert(
      created.cart.contributors[0]!.user_id === host &&
        created.cart.contributors[0]!.display_name === "Host" &&
        created.cart.contributors[0]!.avatar_seed === "HOST",
      "point3: host contributor shape wrong",
    );
    console.log(`[point3] cart ${token} persisted with host contributor`);

    // ---------- Point 4: independent connection reads; unknown -> null ----------
    const cartViaRepo = await cartsRepoA.getByToken(token);
    assert(cartViaRepo !== null, "point4: cart not readable");
    assert(await cartsRepoA.getByToken("gc_does_not_exist") === null, "point4: unknown token not null");
    console.log("[point4] independent read OK; unknown token -> null");

    // ---------- Point 5: distinct contributor is a separate row ----------
    const memberB = await makeUser(dbA, "memberB");
    await addViaPort(portA, token, memberB, "••••1111", "1111", seedData, 1);
    const afterB = await cartsRepoA.getByToken(token);
    assert(afterB !== null && afterB.contributors.length === 2, "point5: distinct contributor not added");
    console.log("[point5] distinct contributor stored as separate row");

    // ---------- Point 6: same-user repeat add appends + preserves + refreshes ----------
    const beforeRepeat = await cartsRepoA.getByToken(token);
    const bRowBefore = beforeRepeat!.contributors.find((c) => c.user_id === memberB)!;
    await new Promise((r) => setTimeout(r, 5));
    await addViaPort(portA, token, memberB, "••••1111", "1111", seedData, 2);
    const afterRepeat = await cartsRepoA.getByToken(token);
    const bRowAfter = afterRepeat!.contributors.find((c) => c.user_id === memberB)!;
    assert(afterRepeat!.contributors.length === 2, "point6: repeat add created extra contributor row");
    assert(bRowAfter.items.length === 2, `point6: items not appended (${bRowAfter.items.length})`);
    assert(
      bRowAfter.items[1]!.quantity === 2 && bRowAfter.items[0]!.quantity === 1,
      "point6: appended item quantities wrong",
    );
    assert(bRowAfter.display_name === "••••1111" && bRowAfter.avatar_seed === "1111", "point6: identity changed");
    assert(
      Date.parse(bRowAfter.added_at) >= Date.parse(bRowBefore.added_at),
      "point6: added_at not refreshed",
    );
    // M3: the cart row's updated_at must advance on a contribution.
    assert(
      Date.parse(afterRepeat!.updated_at) > Date.parse(beforeRepeat!.updated_at),
      `point6: cart updated_at not refreshed (${beforeRepeat!.updated_at} -> ${afterRepeat!.updated_at})`,
    );
    console.log("[point6] same-user repeat appends items, preserves identity, refreshes added_at + cart.updated_at");
  } finally {
    await poolA.end();
  }

  // ---------- Point 7: durability across restart ----------
  const poolB = new Pool({ connectionString: dbUrl, max: 8 });
  const dbB = makeDb(poolB);
  const cartsRepoB = new DrizzleGroupCartRepository(dbB);
  const ordersRepoB = new DrizzleOrderRepository(dbB);
  const portB = new DrizzleGroupOrderTransactionPort(dbB);
  const token = `gc_${runTag}_main`;
  try {
    const persisted = await cartsRepoB.getByToken(token);
    assert(persisted !== null, "point7: cart lost after restart");
    assert(persisted!.contributors.length === 2, "point7: contributors lost after restart");
    const order = await ordersRepoB.getById(persisted!.order_id);
    assert(order !== null, "point7: order lost after restart");
    const totalQty = order!.items.reduce((s, i) => s + i.quantity, 0);
    assert(order!.items.length === 2, `point7: order lines lost (${order!.items.length})`);
    assert(totalQty === 3, `point7: order quantity lost (${totalQty})`);
    console.log("[point7] cart/contributors/order lines durable across a fresh pool");

    // ---------- Point 8: atomic rollback of a failing attribution ----------
    const ghostUser = randomUUID();
    const orderIdBefore = persisted!.order_id;
    const itemsBefore = order!.items.length;
    let rolledBack = false;
    try {
      await portB.runInTransaction(async ({ orders, carts }) => {
        const cart = await carts.lockByToken(token);
        assert(cart, "point8: cart missing");
        const current = await orders.getById(cart.order_id);
        assert(current, "point8: order missing");
        const inputs: OrderItemInput[] = [
          ...current.items.map((oi) => ({
            menu_item_id: oi.menu_item_id,
            name: oi.name,
            base_price: oi.base_price,
            quantity: oi.quantity,
            customizations: oi.customizations,
          })),
          {
            menu_item_id: seedData.menu_item_id,
            name: seedData.menu_item_name,
            base_price: seedData.menu_item_price,
            quantity: 1,
            customizations: [],
          },
        ];
        const breakdown = calculatePriceBreakdown(inputs);
        await orders.setItems(cart.order_id, dtoItems(inputs, breakdown), breakdown);
        await carts.addContribution(token, {
          user_id: ghostUser,
          display_name: "Ghost",
          avatar_seed: "0000",
          items: [
            {
              menu_item_id: seedData.menu_item_id,
              name: seedData.menu_item_name,
              quantity: 1,
              price: seedData.menu_item_price,
            },
          ],
        });
      });
    } catch (err) {
      rolledBack = true;
      // M1: the rollback trigger is specifically the FK violation (23503),
      // not an unrelated error that merely happened to be thrown.
      assert(
        pgErrorCode(err) === "23503",
        `point8: expected PG 23503, got ${pgErrorCode(err) ?? "none"} (${String(err)})`,
      );
    }
    assert(rolledBack, "point8: expected attribution FK failure did not throw");
    const orderAfter = await ordersRepoB.getById(orderIdBefore);
    assert(orderAfter!.items.length === itemsBefore, "point8: order setItems was NOT rolled back");
    const cartAfter = await cartsRepoB.getByToken(token);
    assert(
      !cartAfter!.contributors.some((c) => c.user_id === ghostUser),
      "point8: ghost contributor persisted",
    );
    console.log("[point8] failing attribution rolled back the order setItems atomically");

    // ---------- Point 9: token collision rolls back the WHOLE tx ----------
    const collideToken = `gc_${runTag}_collide`;
    const collideOwner = await makeUser(dbB, "collideA");
    await portB.runInTransaction(async ({ orders, carts }) => {
      const order = await orders.create({
        user_id: collideOwner,
        restaurant_id: seedData.restaurant_id,
        items: [],
        breakdown: calculatePriceBreakdown([]),
      });
      await carts.create({
        token: collideToken,
        order_id: order.id,
        restaurant_id: seedData.restaurant_id,
        created_by: collideOwner,
      });
    });
    const ordersBeforeCollision = (
      await (dbB as unknown as RawDb).execute(
        sql`SELECT count(*)::int AS n FROM orders WHERE user_id = ${collideOwner}`,
      )
    ).rows[0]!.n as number;
    let collisionDetected = false;
    let collisionRolledBack = false;
    const collideOwner2 = await makeUser(dbB, "collideB");
    try {
      await portB.runInTransaction(async ({ orders, carts }) => {
        const order = await orders.create({
          user_id: collideOwner2,
          restaurant_id: seedData.restaurant_id,
          items: [],
          breakdown: calculatePriceBreakdown([]),
        });
        await carts.create({
          token: collideToken,
          order_id: order.id,
          restaurant_id: seedData.restaurant_id,
          created_by: collideOwner2,
        });
      });
    } catch (err) {
      collisionDetected = isGroupCartTokenCollision(err);
      if (collisionDetected) collisionRolledBack = true;
    }
    assert(collisionDetected, "point9: collision not identified as token collision");
    assert(collisionRolledBack, "point9: collision tx not rolled back");
    const collideBOrders = (
      await (dbB as unknown as RawDb).execute(
        sql`SELECT count(*)::int AS n FROM orders WHERE user_id = ${collideOwner2}`,
      )
    ).rows[0]!.n as number;
    assert(collideBOrders === 0, `point9: order from colliding tx persisted (${collideBOrders})`);
    const ownerAOrders = (
      await (dbB as unknown as RawDb).execute(
        sql`SELECT count(*)::int AS n FROM orders WHERE user_id = ${collideOwner}`,
      )
    ).rows[0]!.n as number;
    assert(ownerAOrders === ordersBeforeCollision, "point9: surviving cart's order changed");
    console.log("[point9] token collision rolled back the whole tx; collision classified");

    // ---------- Point 10: order_id uniqueness ----------
    const dupUser = await makeUser(dbB, "dup");
    const firstCartOrder = await ordersRepoB.create({
      user_id: dupUser,
      restaurant_id: seedData.restaurant_id,
      items: [],
      breakdown: calculatePriceBreakdown([]),
    });
    await cartsRepoB.create({
      token: `gc_${runTag}_uniq1`,
      order_id: firstCartOrder.id,
      restaurant_id: seedData.restaurant_id,
      created_by: dupUser,
    });
    let dupRejected = false;
    try {
      await cartsRepoB.create({
        token: `gc_${runTag}_uniq2`,
        order_id: firstCartOrder.id,
        restaurant_id: seedData.restaurant_id,
        created_by: dupUser,
      });
    } catch {
      dupRejected = true;
    }
    assert(dupRejected, "point10: duplicate order_id cart was accepted");
    console.log("[point10] second cart for the same order rejected by group_carts_order_uq");

    // ---------- Points 11 + 12: real concurrency on the row lock ----------
    const concHost = await makeUser(dbB, "concHost");
    const concToken = `gc_${runTag}_conc`;
    await portB.runInTransaction(async ({ orders, carts }) => {
      const order = await orders.create({
        user_id: concHost,
        restaurant_id: seedData.restaurant_id,
        items: [],
        breakdown: calculatePriceBreakdown([]),
      });
      await carts.create({
        token: concToken,
        order_id: order.id,
        restaurant_id: seedData.restaurant_id,
        created_by: concHost,
      });
    });

    // Distinct users -> 5 independent transactions, distinct pool connections.
    const distinctUsers: string[] = [];
    for (let i = 0; i < 5; i += 1) distinctUsers.push(await makeUser(dbB, `conc${i}`));
    await Promise.all(
      distinctUsers.map((uid, i) =>
        addViaPort(portB, concToken, uid, `••••220${i}`, `220${i}`, seedData, 1),
      ),
    );
    const distinctCart = await cartsRepoB.getByToken(concToken);
    const distinctOrder = await ordersRepoB.getById(distinctCart!.order_id);
    assert(
      distinctCart!.contributors.length === 6,
      `point11: expected host + 5 contributors, got ${distinctCart!.contributors.length}`,
    );
    assert(
      distinctOrder!.items.length === 5,
      `point11: lost order lines under concurrency (${distinctOrder!.items.length})`,
    );
    const expectedBreakdown = calculatePriceBreakdown(
      Array.from({ length: 5 }, () => ({
        menu_item_id: seedData.menu_item_id,
        name: seedData.menu_item_name,
        base_price: seedData.menu_item_price,
        quantity: 1,
        customizations: [],
      })),
    );
    assert(
      distinctOrder!.total_amount === expectedBreakdown.total_amount,
      `point11: total not exact (${distinctOrder!.total_amount} != ${expectedBreakdown.total_amount})`,
    );
    console.log(
      `[point11] 5 concurrent distinct-user adds -> contributors=${distinctCart!.contributors.length}, items=${distinctOrder!.items.length}`,
    );

    // Same user -> 5 concurrent adds must append into exactly one row.
    const sameUser = await makeUser(dbB, "same");
    await Promise.all(
      Array.from({ length: 5 }, () =>
        addViaPort(portB, concToken, sameUser, "••••3333", "3333", seedData, 1),
      ),
    );
    const sameCart = await cartsRepoB.getByToken(concToken);
    const sameRows = sameCart!.contributors.filter((c) => c.user_id === sameUser);
    assert(sameRows.length === 1, `point12: same-user rows = ${sameRows.length}`);
    assert(sameRows[0]!.items.length === 5, `point12: appended items = ${sameRows[0]!.items.length}`);
    const sameOrder = await ordersRepoB.getById(sameCart!.order_id);
    assert(
      sameOrder!.items.length === 10,
      `point12: expected 10 order lines, got ${sameOrder!.items.length}`,
    );
    console.log(
      `[point12] 5 concurrent same-user adds -> 1 row, ${sameRows[0]!.items.length} appended items`,
    );
  } finally {
    await poolB.end();
  }

  // ---------- Point 7b: second restart still durable ----------
  const poolC = new Pool({ connectionString: dbUrl, max: 2 });
  const cartsRepoC = new DrizzleGroupCartRepository(makeDb(poolC));
  try {
    const finalCart = await cartsRepoC.getByToken(token);
    assert(finalCart !== null, "final: cart lost after second restart");
    assert(finalCart!.contributors.length === 2, "final: contributors lost after second restart");
    console.log("[durable] cart survived a second pool restart");
  } finally {
    await poolC.end();
  }

  // ---------- Points 13-15: proof closures (A2R2) ----------
  const poolSetup = new Pool({ connectionString: dbUrl, max: 4 });
  const dbS = makeDb(poolSetup);
  const cartsS = new DrizzleGroupCartRepository(dbS);
  const ordersS = new DrizzleOrderRepository(dbS);

  async function createCart(tokenToCreate: string, host: string): Promise<string> {
    const created = await new DrizzleGroupOrderTransactionPort(dbS).runInTransaction(
      async ({ orders, carts }) => {
        const order = await orders.create({
          user_id: host,
          restaurant_id: seedData.restaurant_id,
          items: [],
          breakdown: calculatePriceBreakdown([]),
        });
        await carts.create({
          token: tokenToCreate,
          order_id: order.id,
          restaurant_id: seedData.restaurant_id,
          created_by: host,
        });
        return order;
      },
    );
    return created.id;
  }

  function newService(tokenFactory: () => string): GroupOrderService {
    return new GroupOrderService(
      new DrizzleOrderRepository(dbS),
      new DrizzleCatalogRepository(dbS),
      new DrizzleGroupCartRepository(dbS),
      new DrizzleIdentityRepository(dbS),
      tokenFactory,
    );
  }

  let releaseA: (() => void) | undefined;
  let poolXA: Pool | undefined;
  let poolXB: Pool | undefined;

  try {
    // ===== Point 13: DB locking is PER-CART (no global serialization) =====
    const hostA = await makeUser(dbS, "carta");
    const hostB = await makeUser(dbS, "cartb");
    const memberA = await makeUser(dbS, "membera");
    const memberB = await makeUser(dbS, "memberb");
    const tokenA = `gc_${runTag}_carta`;
    const tokenB = `gc_${runTag}_cartb`;
    const orderAId = await createCart(tokenA, hostA);
    const orderBId = await createCart(tokenB, hostB);

    poolXA = new Pool({ connectionString: dbUrl, max: 1 });
    poolXB = new Pool({ connectionString: dbUrl, max: 1 });
    const portXA = new DrizzleGroupOrderTransactionPort(makeDb(poolXA));
    const portXB = new DrizzleGroupOrderTransactionPort(makeDb(poolXB));

    let signalALocked!: () => void;
    const aLocked = new Promise<void>((r) => {
      signalALocked = r;
    });
    const aRelease = new Promise<void>((r) => {
      releaseA = r;
    });
    let aCommitted = false;

    // Tx A: take the row lock on cart A, signal, then HOLD until released.
    const txA = portXA.runInTransaction(async ({ orders, carts }) => {
      const a = await carts.lockByToken(tokenA);
      assert(a, "point13: cart A lock failed");
      signalALocked();
      await aRelease;
      const inputs: OrderItemInput[] = [
        {
          menu_item_id: seedData.menu_item_id,
          name: seedData.menu_item_name,
          base_price: seedData.menu_item_price,
          quantity: 1,
          customizations: [],
        },
      ];
      const breakdown = calculatePriceBreakdown(inputs);
      await orders.setItems(a.order_id, dtoItems(inputs, breakdown), breakdown);
      await carts.addContribution(tokenA, {
        user_id: memberA,
        display_name: "•A",
        avatar_seed: "AAAA",
        items: [
          {
            menu_item_id: seedData.menu_item_id,
            name: seedData.menu_item_name,
            quantity: 1,
            price: seedData.menu_item_price,
          },
        ],
      });
    });
    txA.then(
      () => {
        aCommitted = true;
      },
      () => {
        aCommitted = true;
      },
    );

    await withTimeout(aLocked, 5000, "point13 A_LOCKED");

    // Tx B runs its FULL mutation path while A's row lock is still held.
    const bStart = Date.now();
    await withTimeout(
      portXB.runInTransaction(async ({ orders, carts }) => {
        const b = await carts.lockByToken(tokenB);
        assert(b, "point13: cart B lock failed");
        const inputs: OrderItemInput[] = [
          {
            menu_item_id: seedData.menu_item_id,
            name: seedData.menu_item_name,
            base_price: seedData.menu_item_price,
            quantity: 1,
            customizations: [],
          },
        ];
        const breakdown = calculatePriceBreakdown(inputs);
        await orders.setItems(b.order_id, dtoItems(inputs, breakdown), breakdown);
        await carts.addContribution(tokenB, {
          user_id: memberB,
          display_name: "•B",
          avatar_seed: "BBBB",
          items: [
            {
              menu_item_id: seedData.menu_item_id,
              name: seedData.menu_item_name,
              quantity: 1,
              price: seedData.menu_item_price,
            },
          ],
        });
      }),
      5000,
      "point13 B_MUTATION",
    );
    const bDurationMs = Date.now() - bStart;
    // B completed while A is provably still held open (releaseA not yet called).
    assert(!aCommitted, "point13: cart A committed before B finished (A not held)");
    const bCartAfter = await cartsS.getByToken(tokenB);
    assert(bCartAfter?.contributors.length === 2, "point13: B contributor not persisted");
    assert(
      (await ordersS.getById(orderBId))?.items.length === 1,
      "point13: B order line not persisted",
    );
    console.log(
      `[point13] cart B full mutation committed in ${bDurationMs}ms while cart A row lock held`,
    );

    // Now release A and confirm it commits normally.
    releaseA?.();
    releaseA = undefined;
    await withTimeout(txA, 5000, "point13 A_COMMIT");
    assert(aCommitted, "point13: cart A did not commit after release");
    const aCartAfter = await cartsS.getByToken(tokenA);
    assert(aCartAfter?.contributors.length === 2, "point13: A contributor not persisted");
    assert(
      (await ordersS.getById(orderAId))?.items.length === 1,
      "point13: A order line not persisted",
    );
    console.log("[point13] both carts finalized correctly; locking is per-cart");

    // ===== Point 14: real service collision -> bounded retry -> success =====
    // Unrelated 23505 must NOT be treated as a token collision.
    assert(
      isGroupCartTokenCollision({
        code: "23505",
        constraint: "group_cart_contributors_member_uq",
      }) === false,
      "point14: member-unique 23505 misclassified as token collision",
    );
    assert(
      isGroupCartTokenCollision({ code: "23505", constraint: "group_carts_pkey" }) === true,
      "point14: group_carts_pkey 23505 not classified as token collision",
    );

    const svcUser = await makeUser(dbS, "svcretry");
    const collideToken = `gc_${runTag}_svc_collide`;
    const collideHost = await makeUser(dbS, "svccollidehost");
    await createCart(collideToken, collideHost);
    const freshToken = `gc_${runTag}_svc_fresh`;
    const seq = [collideToken, freshToken, `gc_${runTag}_svc_unused`];
    let calls = 0;
    const svc = newService(() => seq[calls++]!);

    const svcBefore = await countOrders(dbS, svcUser);
    const result = await svc.createGroupCart({
      user_id: svcUser,
      restaurant_id: seedData.restaurant_id,
    });
    assert(result.group_cart_token === freshToken, `point14: token ${result.group_cart_token} != ${freshToken}`);
    assert(calls === 2, `point14: expected 2 attempts, got ${calls}`);
    const svcAfter = await countOrders(dbS, svcUser);
    assert(svcAfter - svcBefore === 1, `point14: expected exactly 1 surviving order, delta=${svcAfter - svcBefore}`);
    const retriedCart = await cartsS.getByToken(freshToken);
    assert(retriedCart !== null, "point14: successful cart missing");
    assert(retriedCart!.contributors.length === 1, "point14: host contributor missing");
    assert(
      retriedCart!.contributors[0]!.display_name === "Host" &&
        retriedCart!.contributors[0]!.user_id === svcUser,
      "point14: host contributor shape wrong",
    );
    assert((await cartsS.getByToken(collideToken)) !== null, "point14: pre-existing colliding cart lost");
    console.log(
      `[point14] service createGroupCart: attempt1 real PK 23505 -> rolled back -> attempt2 fresh token ${freshToken}`,
    );

    // ===== Point 15: persistent collision -> exhaustion, no orphan orders =====
    const exhaustUser = await makeUser(dbS, "svcexhaust");
    const stuckToken = `gc_${runTag}_svc_stuck`;
    await createCart(stuckToken, await makeUser(dbS, "svcstuckhost"));
    let exhaustCalls = 0;
    const svcExhaust = newService(() => {
      exhaustCalls += 1;
      return stuckToken;
    });
    let exhaustErr: unknown;
    try {
      await svcExhaust.createGroupCart({
        user_id: exhaustUser,
        restaurant_id: seedData.restaurant_id,
      });
    } catch (err) {
      exhaustErr = err;
    }
    assert(exhaustErr !== undefined, "point15: expected exhaustion error");
    assert(
      (exhaustErr as { code?: string }).code === "GROUP_CART_CREATE_FAILED",
      `point15: unexpected error code ${(exhaustErr as { code?: string }).code}`,
    );
    assert((exhaustErr as { status?: number }).status === 500, "point15: error is not 500-class");
    assert(exhaustCalls === 3, `point15: retry bound broken (${exhaustCalls} attempts)`);
    assert(
      (await countOrders(dbS, exhaustUser)) === 0,
      "point15: leaked orphan DRAFT order(s) from failed attempts",
    );
    console.log(
      `[point15] persistent collision -> ${exhaustCalls} attempts -> GROUP_CART_CREATE_FAILED(500), 0 orphan orders`,
    );
  } finally {
    releaseA?.();
    await poolXA?.end().catch(() => undefined);
    await poolXB?.end().catch(() => undefined);
    await poolSetup.end();
  }

  console.log("A2 REAL-PG GROUP-CART DURABILITY PROOF PASSED (15/15 points)");
  console.log(`A2 group cart kept in disposable DB for manual inspection: ${token}`);
}

main().catch((err) => {
  console.error("A2 REAL-PG GROUP-CART DURABILITY FAILED:", err instanceof Error ? err.message : err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause) console.error("CAUSE:", cause);
  process.exitCode = 1;
});
