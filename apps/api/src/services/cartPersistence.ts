import type { RedisLike } from "../lib/redis";
import { getRedis } from "../lib/redis";

// ============================================
// Ordering context service (cart persistence)
// O09 Cart Persistence:
// The cart snapshot is written to Redis (key `cart:{userId}`, EX TTL 24h)
// on every save so a reload on another device never loses the items.
// A read-time inactivity guard enforces the SLA even if the TTL timer is
// unavailable: if `now - saved_at > 24h` the cart is treated as expired,
// deleted, and the caller is told `expired: true`.
// ============================================

export const CART_TTL_SECONDS = 24 * 60 * 60;
export const CART_TTL_MS = CART_TTL_SECONDS * 1000;

export interface CartItemInput {
  menu_item_id: string;
  quantity: number;
  /** Optional metadata stored for a lossless client round-trip. */
  name?: string;
  base_price?: number;
  customizations?: { name: string; price_delta: number }[];
  restaurant_id?: string;
}

export interface CartSnapshot {
  user_id: string;
  restaurant_id: string | null;
  restaurant_name: string | null;
  items: CartItemInput[];
  saved_at: string;
}

export interface CartLoadResult {
  items: CartItemInput[];
  expired: boolean;
  saved_at: string | null;
  expires_at: string | null;
  restaurant_id: string | null;
  restaurant_name: string | null;
}

export class CartPersistenceService {
  /**
   * Clock injection point - tests advance `now` to simulate the 24h
   * inactivity window without real timers.
   */
  now: () => Date;

  constructor(
    private readonly redis: RedisLike = getRedis(),
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  private keyOf(userId: string): string {
    return `cart:${userId}`;
  }

  /** O09: overwrite the persisted snapshot and refresh the 24h TTL. */
  async saveCart(
    userId: string,
    items: CartItemInput[],
    meta?: { restaurant_id?: string | null; restaurant_name?: string | null },
  ): Promise<void> {
    const snapshot: CartSnapshot = {
      user_id: userId,
      restaurant_id: meta?.restaurant_id ?? null,
      restaurant_name: meta?.restaurant_name ?? null,
      items,
      saved_at: this.now().toISOString(),
    };
    await this.redis.set(
      this.keyOf(userId),
      JSON.stringify(snapshot),
      "EX",
      CART_TTL_SECONDS,
    );
  }

  /**
   * O09: load the persisted cart. Returns `expired: true` (and deletes the
   * snapshot) when the cart is older than 24h of inactivity - the caller
   * then shows an empty cart.
   */
  async loadCart(userId: string): Promise<CartLoadResult> {
    const raw = await this.redis.get(this.keyOf(userId));
    if (!raw) return { items: [], expired: false, saved_at: null, expires_at: null, restaurant_id: null, restaurant_name: null };

    let snapshot: CartSnapshot;
    try {
      snapshot = JSON.parse(raw) as CartSnapshot;
    } catch {
      await this.redis.del(this.keyOf(userId));
      return { items: [], expired: false, saved_at: null, expires_at: null, restaurant_id: null, restaurant_name: null };
    }

    const ageMs = this.now().getTime() - Date.parse(snapshot.saved_at);
    const expiresAt = new Date(Date.parse(snapshot.saved_at) + CART_TTL_MS).toISOString();
    if (ageMs > CART_TTL_MS) {
      await this.redis.del(this.keyOf(userId));
      return { items: [], expired: true, saved_at: snapshot.saved_at, expires_at: expiresAt, restaurant_id: null, restaurant_name: null };
    }
    return {
      items: snapshot.items,
      expired: false,
      saved_at: snapshot.saved_at,
      expires_at: expiresAt,
      restaurant_id: snapshot.restaurant_id ?? null,
      restaurant_name: snapshot.restaurant_name ?? null,
    };
  }

  async deleteCart(userId: string): Promise<void> {
    await this.redis.del(this.keyOf(userId));
  }
}

// ============================================
// EOS Layer 1 wiring - shared instance
// ============================================

let cartPersistenceService: CartPersistenceService | null = null;

export function getCartPersistenceService(): CartPersistenceService {
  if (!cartPersistenceService) {
    cartPersistenceService = new CartPersistenceService();
  }
  return cartPersistenceService;
}

/** Test helper: forces a fresh service (and thus fresh clock injection). */
export function resetCartPersistenceService(): void {
  cartPersistenceService = null;
}
