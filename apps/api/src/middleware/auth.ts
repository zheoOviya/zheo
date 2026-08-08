import type { NextFunction, Request, Response } from "express";
import { jwtService } from "../services/jwt";
import { AppError } from "./envelope";

// ============================================
// Auth Middleware (EOS Layer 2.3 - JWT Strategy)
// Extracts user_id from verified JWT sub claim.
// Sets res.locals.userId for downstream handlers.
// Returns 401 on missing / invalid / expired / wrong-type token.
// ============================================

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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

  const token = header.slice(7);
  try {
    const claims = jwtService.verifyAccessToken(token);
    res.locals.userId = claims.sub;
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
