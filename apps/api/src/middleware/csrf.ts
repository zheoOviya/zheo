import type { NextFunction, Request, Response } from "express";
import { config, exactCorsOrigins } from "../config";
import { AppError } from "./envelope";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function csrfOriginGate(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!UNSAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const accessCookie = req.cookies?.[config.jwt.accessCookieName];
  if (typeof accessCookie !== "string" || accessCookie.length === 0) {
    next();
    return;
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && exactCorsOrigins().includes(origin)) {
    next();
    return;
  }

  next(new AppError("FORBIDDEN", "Cross-origin request rejected", 403));
}
