import { randomUUID } from "node:crypto";
import { eq, and, isNull, inArray, isNotNull, type SQL } from "drizzle-orm";
import { gifts } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  GiftRepository,
  GiftDTO,
  GiftStatus,
  CreateGiftInput,
} from "../giftRepository";

function mapGiftRow(row: Record<string, unknown>): GiftDTO {
  return {
    id: row.id as string,
    sender_id: row.sender_id as string,
    restaurant_id: row.restaurant_id as string,
    menu_item_id: row.menu_item_id as string,
    item_snapshot: row.item_snapshot as GiftDTO["item_snapshot"],
    price_paid: Number(row.price_paid),
    message: (row.message as string | null) ?? null,
    recipient_name: (row.recipient_name as string | null) ?? null,
    claim_token: row.claim_token as string,
    claim_code: row.claim_code as string,
    status: row.status as GiftStatus,
    payment_id: (row.payment_id as string | null) ?? null,
    claimed_by: (row.claimed_by as string | null) ?? null,
    claimed_at: (row.claimed_at as Date | null)
      ? (row.claimed_at as Date).toISOString()
      : null,
    fulfilled_at: (row.fulfilled_at as Date | null)
      ? (row.fulfilled_at as Date).toISOString()
      : null,
    refunded_at: (row.refunded_at as Date | null)
      ? (row.refunded_at as Date).toISOString()
      : null,
    redeemed_order_id: (row.redeemed_order_id as string | null) ?? null,
    refund_requested_at: (row.refund_requested_at as Date | null)
      ? (row.refund_requested_at as Date).toISOString()
      : null,
    expires_at: (row.expires_at as Date).toISOString(),
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

export class DrizzleGiftRepository implements GiftRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Runs a guarded UPDATE and reports whether any row matched (CAS). */
  private async casUpdate(
    table: unknown,
    values: Record<string, unknown>,
    cond: SQL<unknown> | undefined,
  ): Promise<boolean> {
    const result = (await this.db
      .update(table)
      .set(values)
      .where(cond as SQL<unknown>)) as unknown as { rowCount?: number };
    return (result.rowCount ?? 0) > 0;
  }

  async create(input: CreateGiftInput): Promise<GiftDTO> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(gifts).values({
      id,
      sender_id: input.sender_id,
      restaurant_id: input.restaurant_id,
      menu_item_id: input.menu_item_id,
      item_snapshot: input.item_snapshot,
      price_paid: String(input.price_paid),
      message: input.message,
      recipient_name: input.recipient_name,
      claim_token: input.claim_token,
      claim_code: input.claim_code,
      status: "PENDING",
      expires_at: new Date(input.expires_at),
      created_at: now,
      updated_at: now,
    });
    const created = await this.getById(id);
    if (!created) throw new Error("gift_create_missing");
    return created;
  }

  async getById(id: string): Promise<GiftDTO | null> {
    const rows = (await this.db
      .select()
      .from(gifts)
      .where(eq(gifts.id, id))) as Record<string, unknown>[];
    return rows[0] ? mapGiftRow(rows[0]) : null;
  }

  async getByToken(token: string): Promise<GiftDTO | null> {
    const rows = (await this.db
      .select()
      .from(gifts)
      .where(eq(gifts.claim_token, token))) as Record<string, unknown>[];
    return rows[0] ? mapGiftRow(rows[0]) : null;
  }

  async getBySender(senderId: string): Promise<GiftDTO[]> {
    // DrizzleDb type doesn't expose orderBy; sort in memory (newest first).
    const rows = (await this.db
      .select()
      .from(gifts)
      .where(eq(gifts.sender_id, senderId))) as Record<string, unknown>[];
    return rows
      .map(mapGiftRow)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async updateStatus(id: string, status: GiftStatus): Promise<GiftDTO | null> {
    await this.db
      .update(gifts)
      .set({ status, updated_at: new Date() })
      .where(eq(gifts.id, id));
    return this.getById(id);
  }

  async markClaimed(id: string, claimedBy: string): Promise<GiftDTO | null> {
    const now = new Date();
    const ok = await this.casUpdate(
      gifts,
      { status: "CLAIMED", claimed_by: claimedBy, claimed_at: now, updated_at: now },
      and(eq(gifts.id, id), eq(gifts.status, "ACTIVE"), isNull(gifts.claimed_by)),
    );
    if (!ok) return null;
    return this.getById(id);
  }

  async release(id: string): Promise<GiftDTO | null> {
    const now = new Date();
    const ok = await this.casUpdate(
      gifts,
      { status: "ACTIVE", claimed_by: null, claimed_at: null, updated_at: now },
      and(eq(gifts.id, id), eq(gifts.status, "CLAIMED"), isNull(gifts.redeemed_order_id)),
    );
    if (!ok) return null;
    return this.getById(id);
  }

  async bindToOrder(id: string, orderId: string): Promise<GiftDTO | null> {
    const now = new Date();
    const ok = await this.casUpdate(
      gifts,
      { redeemed_order_id: orderId, updated_at: now },
      and(eq(gifts.id, id), eq(gifts.status, "CLAIMED"), isNull(gifts.redeemed_order_id)),
    );
    if (!ok) return null;
    return this.getById(id);
  }

  async releaseFromOrder(id: string, orderId: string): Promise<GiftDTO | null> {
    const now = new Date();
    const ok = await this.casUpdate(
      gifts,
      { status: "ACTIVE", claimed_by: null, claimed_at: null, redeemed_order_id: null, updated_at: now },
      and(eq(gifts.id, id), eq(gifts.redeemed_order_id, orderId)),
    );
    if (!ok) return null;
    return this.getById(id);
  }

  async markFulfilled(id: string, orderId: string): Promise<GiftDTO | null> {
    const now = new Date();
    const ok = await this.casUpdate(
      gifts,
      { status: "FULFILLED", fulfilled_at: now, updated_at: now },
      and(eq(gifts.id, id), eq(gifts.status, "CLAIMED"), eq(gifts.redeemed_order_id, orderId)),
    );
    if (!ok) return null;
    return this.getById(id);
  }

  async markRefunded(id: string): Promise<GiftDTO | null> {
    const now = new Date();
    const ok = await this.casUpdate(
      gifts,
      { status: "REFUNDED", refunded_at: now, updated_at: now },
      and(eq(gifts.id, id), inArray(gifts.status, ["REFUNDING", "EXPIRED", "ACTIVE"])),
    );
    if (!ok) return null;
    return this.getById(id);
  }

  async markPaid(id: string): Promise<GiftDTO | null> {
    const now = new Date();
    const ok = await this.casUpdate(
      gifts,
      { status: "ACTIVE", updated_at: now },
      and(eq(gifts.id, id), eq(gifts.status, "PENDING")),
    );
    if (!ok) return null;
    return this.getById(id);
  }

  async markRefundSubmitted(id: string): Promise<GiftDTO | null> {
    const now = new Date();
    const ok = await this.casUpdate(
      gifts,
      { status: "REFUNDING", refund_requested_at: now, updated_at: now },
      and(
        eq(gifts.id, id),
        isNull(gifts.refund_requested_at),
        inArray(gifts.status, ["ACTIVE", "CLAIMED", "EXPIRED", "REFUNDING"]),
      ),
    );
    if (!ok) return null;
    return this.getById(id);
  }

  async clearRefundSubmitted(id: string): Promise<GiftDTO | null> {
    const ok = await this.casUpdate(
      gifts,
      { refund_requested_at: null, updated_at: new Date() },
      and(eq(gifts.id, id), isNotNull(gifts.refund_requested_at)),
    );
    if (!ok) return null;
    return this.getById(id);
  }

  async listDueForExpiry(nowIso: string): Promise<GiftDTO[]> {
    const now = new Date(nowIso);
    const all = (await this.db
      .select()
      .from(gifts)
      .where(eq(gifts.status, "ACTIVE")) as Record<string, unknown>[])
      .concat(
        (await this.db
          .select()
          .from(gifts)
          .where(eq(gifts.status, "CLAIMED"))) as Record<string, unknown>[],
      )
      .concat(
        (await this.db
          .select()
          .from(gifts)
          .where(eq(gifts.status, "PENDING"))) as Record<string, unknown>[],
      )
      .concat(
        (await this.db
          .select()
          .from(gifts)
          .where(eq(gifts.status, "REFUNDING"))) as Record<string, unknown>[],
      )
      .concat(
        (await this.db
          .select()
          .from(gifts)
          .where(eq(gifts.status, "EXPIRED"))) as Record<string, unknown>[],
      );
    return all
      .filter((r) => Date.parse((r.expires_at as Date).toISOString()) <= now.getTime())
      .map(mapGiftRow);
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests should use Memory repos.
  }
}
