import type { NextFunction, Request, Response } from "express";
import { jwtService } from "../services/jwt";
import { assertSessionEpoch, parseEpochClaim } from "../lib/sessionEpoch";
import { sharedIdentityRepo } from "../repositories/shared";
import { resolveAccessToken } from "./auth";
import { AppError } from "./envelope";

// ============================================
// RBAC Middleware (Phase 4, V15 + Sprint 5.1)
// Verifies the Bearer access token AND the role claim.
//  - no / invalid token        -> 401
//  - role not in allow-list    -> 403 FORBIDDEN
// Sets res.locals.userId + res.locals.userRole for downstream handlers.
//
// Sprint 5.1: Added adminReadOnly / adminWrite convenience exports
// for granular admin dashboard RBAC (A-11 OPS_AGENT support).
// ============================================

export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void authorizeRole(allowedRoles, req, res, next);
  };
}

async function authorizeRole(
  allowedRoles: string[],
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = resolveAccessToken(req);
  if (!token) {
    next(
      new AppError(
        "UNAUTHORIZED",
        "Missing or malformed access token",
        401,
      ),
    );
    return;
  }

  let userId: string;
  try {
    const claims = jwtService.verifyAccessToken(token);
    await assertSessionEpoch(claims.sub, parseEpochClaim(claims.session_epoch));
    userId = claims.sub;
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
      return;
    }
    next(new AppError("UNAUTHORIZED", "Invalid access token", 401));
    return;
  }

  const user = await sharedIdentityRepo.getById(userId);
  if (!user) {
    next(new AppError("UNAUTHORIZED", "User no longer exists", 401));
    return;
  }
  if (user.is_suspended) {
    next(new AppError("ACCOUNT_SUSPENDED", "This account is suspended", 403));
    return;
  }

  if (!allowedRoles.includes(user.role)) {
    next(
      new AppError(
        "FORBIDDEN",
        `Role '${user.role}' is not authorized for this operation`,
        403,
      ),
    );
    return;
  }

  res.locals.userId = user.id;
  res.locals.userRole = user.role;
  next();
}

/** ADMIN, SUPER_ADMIN, or OPS_AGENT — read-only dashboard access. */
export const adminReadOnly = requireRole("ADMIN", "SUPER_ADMIN", "OPS_AGENT");

/** ADMIN or SUPER_ADMIN only — destructive/mutating operations. */
export const adminWrite = requireRole("ADMIN", "SUPER_ADMIN");

/** SUPER_ADMIN only — platform-level sensitive operations (e.g. vendor approval). */
export const superAdminOnly = requireRole("SUPER_ADMIN");

/** VENDOR_OWNER or VENDOR_STAFF only — merchant console access. */
export const requireVendorAuth = requireRole("VENDOR_OWNER", "VENDOR_STAFF");

/**
 * Vendor routes also allow ADMIN / SUPER_ADMIN for platform oversight
 * (e.g. support inspecting a merchant's orders or menu). PENDING_VENDOR
 * and CONSUMER are rejected here.
 */
export const requireVendorOrAdmin = requireRole(
  "VENDOR_OWNER",
  "VENDOR_STAFF",
  "ADMIN",
  "SUPER_ADMIN",
);

/** CONSUMER only — consumer account features (cart, profile, loyalty). */
export const requireConsumerAuth = requireRole("CONSUMER");

/**
 * Consumer routes also allow ADMIN / SUPER_ADMIN for platform oversight
 * (e.g. support inspecting a user's cart or spice profile). Vendor roles
 * are rejected here.
 */
export const requireConsumerOrAdmin = requireRole("CONSUMER", "ADMIN", "SUPER_ADMIN");
