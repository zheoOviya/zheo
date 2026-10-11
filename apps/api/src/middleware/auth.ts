import type { NextFunction, Request, Response } from "express";
import { jwtService } from "../services/jwt";
import { config } from "../config";
import { assertSessionEpoch, parseEpochClaim } from "../lib/sessionEpoch";
import { sharedIdentityRepo } from "../repositories/shared";
import { AppError } from "./envelope";

// ============================================
// Auth Middleware (EOS Layer 2.3 - JWT Strategy)
// Extracts user_id from verified JWT sub claim.
// Sets res.locals.userId for downstream handlers.
// Returns 401 on missing / invalid / expired / wrong-type token.
//
// Token resolution order:
//   1. httpOnly access cookie (browser, XSS-safe)
//   2. Authorization: Bearer header (legacy clients / tests)
// ============================================

export function resolveAccessToken(req: Request): string | null {
  const cookie = req.cookies?.[config.jwt.accessCookieName] as string | undefined;
  if (cookie) return cookie;

  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void authenticateAsync(req, res, next);
}

async function authenticateAsync(
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

  try {
    const claims = jwtService.verifyAccessToken(token);
    await assertSessionEpoch(claims.sub, parseEpochClaim(claims.session_epoch));
    const user = await sharedIdentityRepo.getById(claims.sub);
    if (!user) {
      next(new AppError("UNAUTHORIZED", "User no longer exists", 401));
      return;
    }
    if (user.is_suspended) {
      next(new AppError("ACCOUNT_SUSPENDED", "This account is suspended", 403));
      return;
    }
    res.locals.userId = user.id;
    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
    } else {
      next(
        new AppError(
          "UNAUTHORIZED",
          "Invalid access token",
          401,
        ),
      );
    }
  }
}
