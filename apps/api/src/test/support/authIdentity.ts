import { sharedIdentityRepo } from "../../repositories/shared";
import type { IdentityUser } from "../../repositories/identityRepository";

interface SeedableIdentity {
  _getSync?: (id: string) => IdentityUser | null;
  _seed: (user: IdentityUser) => void;
}

export function seedAuthIdentity(claims: {
  sub: string;
  phone: string;
  role: string;
  is_suspended?: boolean;
}): void {
  if (process.env.NODE_ENV !== "test") return;

  const repo = sharedIdentityRepo as SeedableIdentity;
  const existing = typeof repo._getSync === "function" ? repo._getSync(claims.sub) : null;
  if (existing) {
    repo._seed({
      ...existing,
      role: claims.role,
      ...(claims.is_suspended !== undefined
        ? { is_suspended: claims.is_suspended }
        : {}),
    });
    return;
  }

  repo._seed({
    id: claims.sub,
    phone: claims.phone,
    role: claims.role,
    is_suspended: claims.is_suspended ?? false,
    totp_enabled: false,
    created_at: new Date().toISOString(),
  });
}
