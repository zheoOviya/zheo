import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { groupCartContributors, groupCarts } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type { OrderRepository } from "../orderRepository";
import type {
  CreateGroupCartInput,
  GroupCart,
  GroupCartContribution,
  GroupCartContributor,
  GroupCartRepository,
  GroupOrderTransactionPort,
} from "../groupCartRepository";
import { DrizzleGroupOrderTransactionPort } from "./groupOrderTransactionPort";

// ============================================
// Group cart (ordering bounded context, O02) - Drizzle/Postgres.
//
// Mirrors MemoryGroupCartRepository semantics exactly: `create` mints the cart
// row plus the host contributor ("Host"/"HOST"/[]); `addContribution` upserts
// AT MOST one row per (cart, user) and appends items atomically in SQL; reads
// reconstruct the full GroupCart DTO. Item/pricing truth remains in
// orders/order_items - contributors.items is a display projection written in
// the same transaction (see groupOrderTransactionPort).
// ============================================

/** Drizzle's query-builder surface is intentionally not widened by the shared
 *  `DrizzleDb` facade, so the ON CONFLICT clause is reached through a narrow
 *  local type instead of a broad cast. */
type UpsertableInsert = Promise<unknown[]> & {
  onConflictDoUpdate: (config: {
    target: unknown[];
    set: Record<string, unknown>;
  }) => Promise<unknown[]>;
};

function rowsOf(result: unknown): Record<string, unknown>[] {
  return result as Record<string, unknown>[];
}

export class DrizzleGroupCartRepository implements GroupCartRepository {
  constructor(private readonly db: DrizzleDb) {}

  private mapContributor(row: Record<string, unknown>): GroupCartContributor {
    return {
      user_id: row.user_id as string,
      display_name: row.display_name as string,
      avatar_seed: row.avatar_seed as string,
      added_at: (row.added_at as Date).toISOString(),
      items: (row.items as GroupCartContributor["items"]) ?? [],
    };
  }

  private async loadContributors(
    groupCartId: string,
  ): Promise<GroupCartContributor[]> {
    const rows = rowsOf(
      await this.db
        .select()
        .from(groupCartContributors)
        .where(eq(groupCartContributors.group_cart_id, groupCartId)),
    );
    // Deterministic reconstruction (host first): sort by added_at then id.
    return rows
      .map((row) => this.mapContributor(row))
      .sort((a, b) =>
        a.added_at === b.added_at
          ? a.user_id.localeCompare(b.user_id)
          : a.added_at.localeCompare(b.added_at),
      );
  }

  private mapCart(
    row: Record<string, unknown>,
    contributors: GroupCartContributor[],
  ): GroupCart {
    return {
      token: row.token as string,
      order_id: row.order_id as string,
      restaurant_id: row.restaurant_id as string,
      created_by: row.created_by as string,
      created_at: (row.created_at as Date).toISOString(),
      updated_at: (row.updated_at as Date).toISOString(),
      contributors,
    };
  }

  async create(input: CreateGroupCartInput): Promise<GroupCart> {
    const now = new Date();
    await this.db.insert(groupCarts).values({
      token: input.token,
      order_id: input.order_id,
      restaurant_id: input.restaurant_id,
      created_by: input.created_by,
      created_at: now,
      updated_at: now,
    });

    // Host contributor is materialized immediately (memory parity).
    await this.db.insert(groupCartContributors).values({
      id: randomUUID(),
      group_cart_id: input.token,
      user_id: input.created_by,
      display_name: "Host",
      avatar_seed: "HOST",
      items: [],
      added_at: now,
    });

    return {
      token: input.token,
      order_id: input.order_id,
      restaurant_id: input.restaurant_id,
      created_by: input.created_by,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      contributors: [
        {
          user_id: input.created_by,
          display_name: "Host",
          avatar_seed: "HOST",
          added_at: now.toISOString(),
          items: [],
        },
      ],
    };
  }

  async getByToken(token: string): Promise<GroupCart | null> {
    const rows = rowsOf(
      await this.db.select().from(groupCarts).where(eq(groupCarts.token, token)),
    );
    const row = rows[0];
    if (!row) return null;
    return this.mapCart(row, await this.loadContributors(token));
  }

  async lockByToken(token: string): Promise<GroupCart | null> {
    const rows = rowsOf(
      await this.db
        .select()
        .from(groupCarts)
        .where(eq(groupCarts.token, token))
        .for("update"),
    );
    const row = rows[0];
    if (!row) return null;
    return this.mapCart(row, await this.loadContributors(token));
  }

  async addContribution(
    token: string,
    contribution: GroupCartContribution,
  ): Promise<GroupCart | null> {
    const now = new Date();
    const insert = this.db.insert(groupCartContributors).values({
      id: randomUUID(),
      group_cart_id: token,
      user_id: contribution.user_id,
      display_name: contribution.display_name,
      avatar_seed: contribution.avatar_seed,
      items: contribution.items,
      added_at: now,
    }) as unknown as UpsertableInsert;

    // Atomic append: one statement, no application read-modify-write. On a
    // repeat add the existing row's items are concatenated and added_at is
    // refreshed; display_name/avatar_seed are deliberately preserved.
    await insert.onConflictDoUpdate({
      target: [
        groupCartContributors.group_cart_id,
        groupCartContributors.user_id,
      ],
      set: {
        items: sql`${groupCartContributors.items} || excluded.items`,
        added_at: now,
      },
    });

    // Keep the cart's updated_at in lockstep (memory parity); same tx.
    await this.db
      .update(groupCarts)
      .set({ updated_at: now })
      .where(eq(groupCarts.token, token));

    return this.getByToken(token);
  }

  transactionPort(_orders: OrderRepository): GroupOrderTransactionPort {
    return new DrizzleGroupOrderTransactionPort(this.db);
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
