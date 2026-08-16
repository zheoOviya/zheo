import { randomUUID } from "node:crypto";

// ============================================
// Identity context repository (identity bounded context)
// Phone-keyed stable user identity. Previously the auth
// route minted a random UUID on every login, which broke
// repeat-customer math (each login looked like a new user).
// This repository keys users on their phone number so POS
// (Petpooja) and web orders share the same user_id.
//
// Sprint 5.2: Added is_suspended, listAll, suspend, reactivate
// for admin user management (A-06).
// ============================================

export interface IdentityUser {
  id: string;
  phone: string;
  /** Admin console login identifier. Nullable for consumer/vendor users. */
  email?: string | null;
  /**
   * Role identifier. Built-in values come from the canonical role catalog
   * (CONSUMER, VENDOR_OWNER, ...); custom roles defined by a SUPER_ADMIN
   * via the admin console are stored as free text.
   */
  role: string;
  /** D03 spice tolerance (1 = mild, 5 = extreme). Undefined until set. */
  spice_tolerance?: number;
  /** A-06: admin user suspension flag. */
  is_suspended: boolean;
  suspended_reason?: string | null;
  /** TOTP 2FA: base32 secret. Present once enrollment is started. */
  totp_secret?: string | null;
  /** TOTP 2FA: whether the authenticator code was confirmed & active. */
  totp_enabled: boolean;
  totp_confirmed_at?: string | null;
  created_at: string;
}

export interface IdentityRepository {
  getById(id: string): Promise<IdentityUser | null>;
  getByPhone(phone: string): Promise<IdentityUser | null>;
  /** Admin login: resolve an operator account by its email. */
  getByEmail(email: string): Promise<IdentityUser | null>;
  /** Returns the existing user for a phone or creates one (idempotent). */
  ensureByPhone(phone: string, role?: IdentityUser["role"]): Promise<IdentityUser>;
  /** Creates a user for a phone, returning null when the phone is already taken. */
  createByPhone(phone: string, role?: IdentityUser["role"]): Promise<IdentityUser | null>;
  /** D03: sets the user's spice tolerance (1-5). */
  updateSpiceTolerance(
    userId: string,
    tolerance: number,
  ): Promise<IdentityUser | null>;
  /** A-06: paginated user listing with optional phone search and role filter. */
  listAll(page: number, limit: number, searchPhone?: string, role?: IdentityUser["role"]): Promise<{ items: IdentityUser[]; total: number }>;
  /** A-06: suspend a user by id, optionally recording a reason. */
  suspend(userId: string, reason?: string | null): Promise<IdentityUser | null>;
  /** A-06: reactivate a suspended user by id. */
  reactivate(userId: string): Promise<IdentityUser | null>;
  /** A-06: update user role (SUPER_ADMIN only). */
  updateRole(userId: string, role: IdentityUser["role"]): Promise<IdentityUser | null>;
  /** 2FA: persist a fresh TOTP secret (enrollment started, not yet active). */
  setTotpSecret(userId: string, secret: string): Promise<IdentityUser | null>;
  /** 2FA: mark TOTP as enabled+confirmed. */
  enableTotp(userId: string): Promise<IdentityUser | null>;
  /** 2FA: clear secret and disable TOTP. */
  disableTotp(userId: string): Promise<IdentityUser | null>;
  /** Test helper: seeds a user with a known id/phone pair. */
  _seed(user: IdentityUser): void;
  _reset(): void;
}

export class MemoryIdentityRepository implements IdentityRepository {
  private readonly users = new Map<string, IdentityUser>();
  private readonly usersById = new Map<string, IdentityUser>();
  private readonly usersByEmail = new Map<string, IdentityUser>();

  async getById(id: string): Promise<IdentityUser | null> {
    return this.usersById.get(id) ?? null;
  }

  async getByPhone(phone: string): Promise<IdentityUser | null> {
    return this.users.get(phone) ?? null;
  }

  async getByEmail(email: string): Promise<IdentityUser | null> {
    const key = email.trim().toLowerCase();
    if (!key) return null;
    return this.usersByEmail.get(key) ?? null;
  }

  /** Keeps the phone/id/email indexes consistent for every mutation. */
  private indexUser(user: IdentityUser): void {
    this.users.set(user.phone, user);
    this.usersById.set(user.id, user);
    const key = user.email?.trim().toLowerCase();
    if (key) {
      this.usersByEmail.set(key, user);
    } else {
      // If email was cleared, drop any stale index for this user id.
      for (const [k, v] of this.usersByEmail) {
        if (v.id === user.id) this.usersByEmail.delete(k);
      }
    }
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
      is_suspended: false,
      totp_enabled: false,
      created_at: new Date().toISOString(),
    };
    this.indexUser(user);
    return user;
  }

  async createByPhone(
    phone: string,
    role: IdentityUser["role"] = "CONSUMER",
  ): Promise<IdentityUser | null> {
    if (this.users.has(phone)) return null;
    const user: IdentityUser = {
      id: randomUUID(),
      phone,
      role,
      is_suspended: false,
      totp_enabled: false,
      created_at: new Date().toISOString(),
    };
    this.indexUser(user);
    return user;
  }

  async setTotpSecret(userId: string, secret: string): Promise<IdentityUser | null> {
    const user = this.usersById.get(userId);
    if (!user) return null;
    const updated: IdentityUser = { ...user, totp_secret: secret };
    this.indexUser(updated);
    return updated;
  }

  async enableTotp(userId: string): Promise<IdentityUser | null> {
    const user = this.usersById.get(userId);
    if (!user) return null;
    const updated: IdentityUser = {
      ...user,
      totp_enabled: true,
      totp_confirmed_at: new Date().toISOString(),
    };
    this.indexUser(updated);
    return updated;
  }

  async disableTotp(userId: string): Promise<IdentityUser | null> {
    const user = this.usersById.get(userId);
    if (!user) return null;
    const updated: IdentityUser = {
      ...user,
      totp_enabled: false,
      totp_secret: null,
      totp_confirmed_at: null,
    };
    this.indexUser(updated);
    return updated;
  }

  _seed(user: IdentityUser): void {
    this.indexUser(user);
  }

  async updateSpiceTolerance(
    userId: string,
    tolerance: number,
  ): Promise<IdentityUser | null> {
    const user = this.usersById.get(userId);
    if (!user) return null;
    const updated: IdentityUser = { ...user, spice_tolerance: tolerance };
    this.indexUser(updated);
    return updated;
  }

  async listAll(page: number, limit: number, searchPhone?: string, role?: IdentityUser["role"]): Promise<{ items: IdentityUser[]; total: number }> {
    let all = Array.from(this.users.values());
    if (searchPhone) {
      all = all.filter((u) => u.phone.includes(searchPhone));
    }
    if (role) {
      all = all.filter((u) => u.role === role);
    }
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const total = all.length;
    const offset = (page - 1) * limit;
    const items = all.slice(offset, offset + limit);
    return { items, total };
  }

  async suspend(userId: string, reason?: string | null): Promise<IdentityUser | null> {
    const user = this.usersById.get(userId);
    if (!user) return null;
    const updated: IdentityUser = {
      ...user,
      is_suspended: true,
      suspended_reason: reason ?? null,
    };
    this.indexUser(updated);
    return updated;
  }

  async reactivate(userId: string): Promise<IdentityUser | null> {
    const user = this.usersById.get(userId);
    if (!user) return null;
    const updated: IdentityUser = { ...user, is_suspended: false };
    this.indexUser(updated);
    return updated;
  }

  async updateRole(userId: string, role: IdentityUser["role"]): Promise<IdentityUser | null> {
    const user = this.usersById.get(userId);
    if (!user) return null;
    const updated: IdentityUser = { ...user, role };
    this.indexUser(updated);
    return updated;
  }

  _reset(): void {
    this.users.clear();
    this.usersById.clear();
    this.usersByEmail.clear();
  }
}
