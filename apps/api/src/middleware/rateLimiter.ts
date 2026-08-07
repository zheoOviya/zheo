import type { NextFunction, Request, Response } from "express";
import { getRedis } from "../lib/redis";
import { logger } from "../lib/logger";
import { AppError } from "./envelope";

// ============================================
// Redis Sliding Window Rate Limiting (PRD Section 4)
// Window tracked via a Redis sorted set:
//   ZADD key <now> <randomMember>
//   ZREMRANGEBYSCORE key 0 <now - windowMs>
//   ZCARD key  -> count of requests in the window
//   PEXPIRE key windowMs (housekeeping)
//
// Sprint 6: Added failClosed option. When true, Redis
// failures reject requests with 503 instead of allowing
// them through. Used for security-critical routes
// (auth, payments, OTP, admin write).
// ============================================

export interface RateLimiterOptions {
  prefix: string;
  max: number;
  windowMs: number;
  identifier: (req: Request) => string;
  failClosed?: boolean;
}

export async function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
  failClosed = false,
): Promise<{ allowed: boolean; current: number }> {
  const redis = getRedis();
  const now = Date.now();
  const member = `${now}-${Math.random().toString(36).slice(2)}`;

  try {
    await redis.zremrangebyscore(key, 0, now - windowMs);
    await redis.zadd(key, now, member);
    const current = await redis.zcard(key);
    await redis.pexpire(key, windowMs);

    return { allowed: current <= max, current };
  } catch (err) {
    logger.warn({
      message: "rate_limit_redis_failure",
      error: err instanceof Error ? err.message : String(err),
      fail_closed: failClosed,
    });

    if (failClosed) {
      return { allowed: false, current: -1 };
    }
    return { allowed: true, current: 0 };
  }
}

export function rateLimiter(options: RateLimiterOptions) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const identifier = options.identifier(req);
    const key = `rl:${options.prefix}:${identifier}`;
    const result = await checkRateLimit(key, options.max, options.windowMs, options.failClosed);
    if (!result.allowed) {
      const status = result.current === -1 ? 503 : 429;
      const message = result.current === -1
        ? "Rate limiting temporarily unavailable"
        : `Rate limit exceeded: ${result.current}/${options.max} per window`;
      next(
        new AppError(
          "RATE_LIMIT_EXCEEDED",
          message,
          status,
        ),
      );
      return;
    }
    res.setHeader("X-RateLimit-Limit", String(options.max));
    res.setHeader("X-RateLimit-Remaining", String(options.max - result.current));
    next();
  };
}
