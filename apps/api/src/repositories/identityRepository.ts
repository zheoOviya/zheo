import { randomUUID } from "node:crypto";

// ============================================
// Identity context repository (identity bounded context)
// Phone-keyed stable user identity. Previously the auth
// route minted a random UUID on every login, which broke
// repeat-customer math (each login looked like a new user).
// This repository keys users on their phone number so POS
// (Petpooja) and web orders share the same user_id.
// ============================================

export interface IdentityUser {
  id: string;
  phone: string;
  role:
    | "CONSUMER"
    | "VENDOR"
    | "VENDOR_OWNER"
    | "VENDOR_STAFF"
    | "OPS_AGENT"
    | "ADMIN"
    | "SUPER_ADMIN";
  /** D03 spice tolerance (1 = mild, 5 = extreme). Undefined until set. */
  spice_tolerance?: number;
  created_at: string;
}

export interface IdentityRepository {
  getById(id: string): Promise<IdentityUser | null>;
  getByPhone(phone: string): Promise<IdentityUser | null>;
  /** Returns the existing user for a phone or creates one (idempotent). */
  ensureByPhone(phone: string, role?: IdentityUser["role"]): Promise<IdentityUser>;
  /** D03: sets the user's spice tolerance (1-5). */
  updateSpiceTolerance(
    userId: string,
    tolerance: number,
  ): Promise<IdentityUser | null>;
  /** Test helper: seeds a user with a known id/phone pair. */
  _seed(user: IdentityUser): void;
  _reset(): void;
}

export class MemoryIdentityRepository implements IdentityRepository {
  private readonly users = new Map<string, IdentityUser>();

  async getById(id: string): Promise<IdentityUser | null> {
    for (const user of this.users.values()) {
      if (user.id === id) return user;
    }
    return null;
  }

  async getByPhone(phone: string): Promise<IdentityUser | null> {
    return this.users.get(phone) ?? null;
  }

  async ensureByPhone(
    phone: string,
    role: IdentityUser["role"] = "CONSUMER",
  ): Promise<IdentityUser> {
    const existing = this.users.get(phone);
    if (existing) return existing;
    const user: IdentityUser = {
      id: randomUUID(),
      phone,
      role,
      created_at: new Date().toISOString(),
    };
    this.users.set(phone, user);
    return user;
  }

  _seed(user: IdentityUser): void {
    this.users.set(user.phone, user);
  }

  async updateSpiceTolerance(
    userId: string,
    tolerance: number,
  ): Promise<IdentityUser | null> {
    for (const [phone, user] of this.users.entries()) {
      if (user.id === userId) {
        const updated: IdentityUser = {
          ...user,
          spice_tolerance: tolerance,
        };
        this.users.set(phone, updated);
        return updated;
      }
    }
    return null;
  }

  _reset(): void {
    this.users.clear();
  }
}
