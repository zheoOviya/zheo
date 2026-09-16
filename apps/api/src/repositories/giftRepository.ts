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
  /**
   * CAS cancel: only succeeds while the row is still PENDING, so a payment
   * capture (PENDING -> ACTIVE) that lands first can never be clobbered.
   */
  cancelPending(id: string): Promise<GiftDTO | null>;
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
  /**
   * CAS refund-confirm: only from a state that already entered the refund
   * lifecycle (REFUNDING/EXPIRED). A stale confirmation can therefore never
   * regress a freshly ACTIVE/CLAIMED gift produced by a valid later
   * transition (e.g. releaseFromOrder).
   */
  markRefunded(id: string): Promise<GiftDTO | null>;
  /** CAS paid-confirm: only PENDING -> ACTIVE (never clobbers CANCELLED/EXPIRED). */
  markPaid(id: string): Promise<GiftDTO | null>;
  /**
   * CAS refund-submit: reserves the one-shot gateway submission
   * (refund_requested_at) and moves the gift to REFUNDING, but only when the
   * row is still in one of the caller's `from` states and has no marker yet.
   */
  markRefundSubmitted(id: string, from: GiftStatus[]): Promise<GiftDTO | null>;
  /** CAS refund-hold: moves a `from`-state gift to REFUNDING without reserving a submission. */
  markRefunding(id: string, from: GiftStatus[]): Promise<GiftDTO | null>;
  /** Clears the refund-submitted marker after a failed submission. */
  clearRefundSubmitted(id: string): Promise<GiftDTO | null>;
  /**
   * Atomic expiry: only a still-due, still-unbound PENDING/ACTIVE/CLAIMED gift
   * becomes EXPIRED. A gift bound after the sweep's read loses the race.
   */
  expireIfDueAndUnbound(id: string, nowIso: string): Promise<GiftDTO | null>;
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

  async cancelPending(id: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.status !== "PENDING") return null;
    const updated = { ...gift, status: "CANCELLED" as const, updated_at: new Date().toISOString() };
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
    // Only a gift already in the refund lifecycle may be confirmed; ACTIVE is
    // deliberately excluded so a stale confirmation cannot regress a gift that
    // a later valid transition released back to ACTIVE.
    if (!["REFUNDING", "EXPIRED"].includes(gift.status)) return null;
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

  async markRefundSubmitted(id: string, from: GiftStatus[]): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    // CAS: exactly one submission, and never regress a FULFILLED/CANCELLED/
    // PENDING/CLAIMED-bound gift (bound gifts are excluded upstream by the
    // sweep, this guard is the last line of defense).
    if (gift.refund_requested_at !== null) return null;
    if (!from.includes(gift.status)) return null;
    const now = new Date().toISOString();
    const updated = {
      ...gift,
      status: "REFUNDING" as const,
      refund_requested_at: now,
      updated_at: now,
    };
    this.gifts.set(id, updated);
    return updated;
  }

  async markRefunding(id: string, from: GiftStatus[]): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (!from.includes(gift.status)) return null;
    const updated = { ...gift, status: "REFUNDING" as const, updated_at: new Date().toISOString() };
    this.gifts.set(id, updated);
    return updated;
  }

  async expireIfDueAndUnbound(id: string, nowIso: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    if (gift.status !== "PENDING" && gift.status !== "ACTIVE" && gift.status !== "CLAIMED") {
      return null;
    }
    if (gift.redeemed_order_id !== null) return null;
    if (Date.parse(gift.expires_at) > Date.parse(nowIso)) return null;
    const updated = { ...gift, status: "EXPIRED" as const, updated_at: new Date().toISOString() };
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
