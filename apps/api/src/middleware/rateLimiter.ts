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
// ============================================

export interface RateLimiterOptions {
  prefix: string;
  max: number;
  windowMs: number;
  identifier: (req: Request) => string;
}

export async function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
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
    // Resilience (ECS): fail-open when Redis is unavailable rather than
    // blocking all traffic during an outage.
    logger.warn({
      message: "rate_limit_redis_failure",
      error: err instanceof Error ? err.message : String(err),
    });
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
    const result = await checkRateLimit(key, options.max, options.windowMs);
    if (!result.allowed) {
      next(
        new AppError(
          "RATE_LIMIT_EXCEEDED",
          `Rate limit exceeded: ${result.current}/${options.max} per window`,
          429,
        ),
      );
      return;
    }
    res.setHeader("X-RateLimit-Limit", String(options.max));
    res.setHeader("X-RateLimit-Remaining", String(options.max - result.current));
    next();
  };
}
