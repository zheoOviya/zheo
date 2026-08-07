import type { NextFunction, Request, Response } from "express";
import { jwtService } from "../services/jwt";
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
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      next(
        new AppError(
          "UNAUTHORIZED",
          "Missing or malformed Authorization header",
          401,
        ),
      );
      return;
    }

    let role: string;
    try {
      const claims = jwtService.verifyAccessToken(header.slice(7));
      role = claims.role;
      res.locals.userId = claims.sub;
      res.locals.userRole = role;
    } catch (err) {
      if (err instanceof AppError) {
        next(err);
        return;
      }
      next(new AppError("UNAUTHORIZED", "Invalid access token", 401));
      return;
    }

    if (!allowedRoles.includes(role)) {
      next(
        new AppError(
          "FORBIDDEN",
          `Role '${role}' is not authorized for this operation`,
          403,
        ),
      );
      return;
    }

    next();
  };
}

/** ADMIN, SUPER_ADMIN, or OPS_AGENT — read-only dashboard access. */
export const adminReadOnly = requireRole("ADMIN", "SUPER_ADMIN", "OPS_AGENT");

/** ADMIN or SUPER_ADMIN only — destructive/mutating operations. */
export const adminWrite = requireRole("ADMIN", "SUPER_ADMIN");
