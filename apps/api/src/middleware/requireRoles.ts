import type { NextFunction, Request, Response } from "express";
import { jwtService } from "../services/jwt";
import { AppError } from "./envelope";

// ============================================
// RBAC Middleware (Phase 4, V15)
// Verifies the Bearer access token AND the role claim.
//  - no / invalid token        -> 401
//  - role not in allow-list    -> 403 FORBIDDEN
// Sets res.locals.userId + res.locals.userRole for downstream handlers.
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
          `Role ${role} is not allowed to access chain-level data`,
          403,
        ),
      );
      return;
    }

    next();
  };
}
