import { randomUUID } from "node:crypto";
import type { GiftItemSnapshot } from "@snakzap/db";

export type GiftStatus =
  | "PENDING"
  | "ACTIVE"
  | "CLAIMED"
  | "FULFILLED"
  | "EXPIRED"
  | "REFUNDING"
  | "REFUNDED"
  | "CANCELLED";

export interface GiftDTO {
  id: string;
  sender_id: string;
  restaurant_id: string;
  menu_item_id: string;
  item_snapshot: GiftItemSnapshot;
  price_paid: number;
  message: string | null;
  recipient_name: string | null;
  claim_token: string;
  claim_code: string;
  status: GiftStatus;
  payment_id: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  fulfilled_at: string | null;
  refunded_at: string | null;
  /** Order that redeemed this gift; null until the gift is bound at checkout. */
  redeemed_order_id: string | null;
  /** Set once a refund has been successfully submitted to the gateway. */
  refund_requested_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CreateGiftInput {
  sender_id: string;
  restaurant_id: string;
  menu_item_id: string;
  item_snapshot: GiftItemSnapshot;
  price_paid: number;
  message: string | null;
  recipient_name: string | null;
  claim_token: string;
  claim_code: string;
  expires_at: string;
}

export interface GiftRepository {
  create(input: CreateGiftInput): Promise<GiftDTO>;
  getById(id: string): Promise<GiftDTO | null>;
  getByToken(token: string): Promise<GiftDTO | null>;
  getBySender(senderId: string): Promise<GiftDTO[]>;
  updateStatus(id: string, status: GiftStatus): Promise<GiftDTO | null>;
  /**
   * CAS claim: only succeeds while the gift is ACTIVE and unclaimed. Returns
   * null when a concurrent claim won, so "fulfills exactly once" holds.
   */
  markClaimed(id: string, claimedBy: string): Promise<GiftDTO | null>;
  /** CAS release: only from CLAIMED and only if not bound to an order. */
  release(id: string): Promise<GiftDTO | null>;
  /** CAS bind: only while CLAIMED and not already redeemed in another order. */
  bindToOrder(id: string, orderId: string): Promise<GiftDTO | null>;
  /** CAS unbind: clears the order binding only when this order holds it. */
  releaseFromOrder(id: string, orderId: string): Promise<GiftDTO | null>;
  /** CAS fulfill: only from CLAIMED by the order that redeemed the gift. */
  markFulfilled(id: string, orderId: string): Promise<GiftDTO | null>;
  /** CAS refund-confirm: only from REFUNDING/EXPIRED/ACTIVE (not yet REFUNDED). */
  markRefunded(id: string): Promise<GiftDTO | null>;
  /** CAS paid-confirm: only PENDING -> ACTIVE (never clobbers CANCELLED/EXPIRED). */
  markPaid(id: string): Promise<GiftDTO | null>;
  /** CAS refund-submit: records the submission exactly once. */
  markRefundSubmitted(id: string): Promise<GiftDTO | null>;
  /** Clears the refund-submitted marker after a failed submission. */
  clearRefundSubmitted(id: string): Promise<GiftDTO | null>;
  listDueForExpiry(nowIso: string): Promise<GiftDTO[]>;
  _reset(): void;
}

export class MemoryGiftRepository implements GiftRepository {
  private gifts = new Map<string, GiftDTO>();

  async create(input: CreateGiftInput): Promise<GiftDTO> {
    const now = new Date().toISOString();
    const gift: GiftDTO = {
      id: randomUUID(),
      sender_id: input.sender_id,
      restaurant_id: input.restaurant_id,
      menu_item_id: input.menu_item_id,
      item_snapshot: input.item_snapshot,
      price_paid: input.price_paid,
      message: input.message,
      recipient_name: input.recipient_name,
      claim_token: input.claim_token,
      claim_code: input.claim_code,
      status: "PENDING",
      payment_id: null,
      claimed_by: null,
      claimed_at: null,
      fulfilled_at: null,
      refunded_at: null,
      redeemed_order_id: null,
      refund_requested_at: null,
      expires_at: input.expires_at,
      created_at: now,
      updated_at: now,
    };
    this.gifts.set(gift.id, gift);
    return gift;
  }

  async getById(id: string): Promise<GiftDTO | null> {
    return this.gifts.get(id) ?? null;
  }

  async getByToken(token: string): Promise<GiftDTO | null> {
    for (const g of this.gifts.values()) {
      if (g.claim_token === token) return g;
    }
    return null;
  }

  async getBySender(senderId: string): Promise<GiftDTO[]> {
    return [...this.gifts.values()]
      .filter((g) => g.sender_id === senderId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async updateStatus(id: string, status: GiftStatus): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    const updated = { ...gift, status, updated_at: new Date().toISOString() };
    this.gifts.set(id, updated);
    return updated;
  }

  async markClaimed(id: string, claimedBy: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.status !== "ACTIVE" || gift.claimed_by !== null) return null;
    const now = new Date().toISOString();
    const updated = {
      ...gift,
      status: "CLAIMED" as const,
      claimed_by: claimedBy,
      claimed_at: now,
      updated_at: now,
    };
    this.gifts.set(id, updated);
    return updated;
  }

  async release(id: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.status !== "CLAIMED" || gift.redeemed_order_id !== null) return null;
    const now = new Date().toISOString();
    const updated = {
      ...gift,
      status: "ACTIVE" as const,
      claimed_by: null,
      claimed_at: null,
      updated_at: now,
    };
    this.gifts.set(id, updated);
    return updated;
  }

  async bindToOrder(id: string, orderId: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.status !== "CLAIMED" || gift.redeemed_order_id !== null) return null;
    const updated = { ...gift, redeemed_order_id: orderId, updated_at: new Date().toISOString() };
    this.gifts.set(id, updated);
    return updated;
  }

  async releaseFromOrder(id: string, orderId: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.redeemed_order_id !== orderId) return null;
    const now = new Date().toISOString();
    const updated = {
      ...gift,
      status: "ACTIVE" as const,
      claimed_by: null,
      claimed_at: null,
      redeemed_order_id: null,
      updated_at: now,
    };
    this.gifts.set(id, updated);
    return updated;
  }

  async markFulfilled(id: string, orderId: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.status !== "CLAIMED" || gift.redeemed_order_id !== orderId) return null;
    const now = new Date().toISOString();
    const updated = { ...gift, status: "FULFILLED" as const, fulfilled_at: now, updated_at: now };
    this.gifts.set(id, updated);
    return updated;
  }

  async markRefunded(id: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (!["REFUNDING", "EXPIRED", "ACTIVE"].includes(gift.status)) return null;
    const now = new Date().toISOString();
    const updated = { ...gift, status: "REFUNDED" as const, refunded_at: now, updated_at: now };
    this.gifts.set(id, updated);
    return updated;
  }

  async markPaid(id: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.status !== "PENDING") return null;
    const updated = { ...gift, status: "ACTIVE" as const, updated_at: new Date().toISOString() };
    this.gifts.set(id, updated);
    return updated;
  }

  async markRefundSubmitted(id: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.refund_requested_at !== null) return null;
    const updated = {
      ...gift,
      status: "REFUNDING" as const,
      refund_requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.gifts.set(id, updated);
    return updated;
  }

  async clearRefundSubmitted(id: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.refund_requested_at === null) return null;
    const updated = { ...gift, refund_requested_at: null, updated_at: new Date().toISOString() };
    this.gifts.set(id, updated);
    return updated;
  }

  async listDueForExpiry(nowIso: string): Promise<GiftDTO[]> {
    const now = Date.parse(nowIso);
    return [...this.gifts.values()].filter((g) => {
      if (g.status === "FULFILLED" || g.status === "REFUNDED" || g.status === "CANCELLED") {
        return false;
      }
      return Date.parse(g.expires_at) <= now;
    });
  }

  _reset(): void {
    this.gifts.clear();
  }
}
