import { getRedis } from "./redis";
import { AppError } from "../middleware/envelope";

const EPOCH_KEY_PREFIX = "auth:session_epoch:";

export function sessionEpochKey(userId: string): string {
  return `${EPOCH_KEY_PREFIX}${userId}`;
}

function storeUnavailable(): never {
  throw new AppError(
    "SERVICE_UNAVAILABLE",
    "Session store temporarily unavailable",
    503,
  );
}

function invalidToken(): never {
  throw new AppError("INVALID_TOKEN", "Token is missing required claims", 401);
}

export function parseStoredEpoch(raw: string | null): number {
  if (raw === null) return 0;
  if (!/^[0-9]+$/.test(raw)) {
    storeUnavailable();
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    storeUnavailable();
  }
  return value;
}

export function parseEpochClaim(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidToken();
  }
  return value;
}

async function withSessionStore<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof AppError) throw err;
    storeUnavailable();
  }
}

export async function getSessionEpoch(userId: string): Promise<number> {
  return withSessionStore(async () => {
    const redis = getRedis();
    const raw = await redis.get(sessionEpochKey(userId));
    return parseStoredEpoch(raw);
  });
}

export async function incrementSessionEpoch(userId: string): Promise<number> {
  return withSessionStore(async () => {
    const redis = getRedis();
    const key = sessionEpochKey(userId);
    const raw = await redis.get(key);
    if (raw !== null) {
      parseStoredEpoch(raw);
    }
    const next = await redis.incr(key);
    if (!Number.isSafeInteger(next) || next < 0) {
      storeUnavailable();
    }
    return next;
  });
}

export async function assertSessionEpoch(
  userId: string,
  tokenEpoch: number,
): Promise<void> {
  const current = await getSessionEpoch(userId);
  if (tokenEpoch !== current) {
    throw new AppError("SESSION_REVOKED", "Session has been revoked", 401);
  }
}
