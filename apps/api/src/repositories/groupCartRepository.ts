import { randomUUID } from "node:crypto";

// ============================================
// Group cart repository (ordering bounded context)
// Holds the shareable cart alongside its DRAFT order. The order itself
// lives in the OrderRepository (single DRAFT order); this repo tracks WHO
// added WHAT so the live group cart can render per-contributor avatars.
//
// Concurrency: all writes flow through the GroupOrderService per-token async
// mutex, so read-modify-write on `contributors` is serialized per cart.
// ============================================

export interface GroupCartContributionItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  price: number;
}

export interface GroupCartContributor {
  user_id: string;
  /** Masked phone, e.g. "98••••4321" - never the raw number. */
  display_name: string;
  /** Stable seed (last 4 phone digits) for the avatar initial circle. */
  avatar_seed: string;
  added_at: string;
  items: GroupCartContributionItem[];
}

export interface GroupCart {
  token: string;
  order_id: string;
  restaurant_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  contributors: GroupCartContributor[];
}

export interface CreateGroupCartInput {
  token: string;
  order_id: string;
  restaurant_id: string;
  created_by: string;
}

export interface GroupCartContribution {
  user_id: string;
  display_name: string;
  avatar_seed: string;
  items: GroupCartContributionItem[];
}

export interface GroupCartRepository {
  create(input: CreateGroupCartInput): Promise<GroupCart>;
  getByToken(token: string): Promise<GroupCart | null>;
  addContribution(
    token: string,
    contribution: GroupCartContribution,
  ): Promise<GroupCart | null>;
  _reset(): void;
}

export class MemoryGroupCartRepository implements GroupCartRepository {
  private readonly carts = new Map<string, GroupCart>();

  async create(input: CreateGroupCartInput): Promise<GroupCart> {
    const now = new Date().toISOString();
    const cart: GroupCart = {
      token: input.token,
      order_id: input.order_id,
      restaurant_id: input.restaurant_id,
      created_by: input.created_by,
      created_at: now,
      updated_at: now,
      contributors: [
        {
          user_id: input.created_by,
          display_name: "Host",
          avatar_seed: "HOST",
          added_at: now,
          items: [],
        },
      ],
    };
    this.carts.set(input.token, cart);
    return cart;
  }

  async getByToken(token: string): Promise<GroupCart | null> {
    return this.carts.get(token) ?? null;
  }

  async addContribution(
    token: string,
    contribution: GroupCartContribution,
  ): Promise<GroupCart | null> {
    const cart = this.carts.get(token);
    if (!cart) return null;

    const existing = cart.contributors.find(
      (c) => c.user_id === contribution.user_id,
    );
    if (existing) {
      existing.items.push(...contribution.items);
      existing.added_at = new Date().toISOString();
    } else {
      cart.contributors.push({
        user_id: contribution.user_id,
        display_name: contribution.display_name,
        avatar_seed: contribution.avatar_seed,
        added_at: new Date().toISOString(),
        items: [...contribution.items],
      });
    }
    cart.updated_at = new Date().toISOString();
    this.carts.set(token, cart);
    return cart;
  }

  _reset(): void {
    this.carts.clear();
  }
}
