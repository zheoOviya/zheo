import { randomUUID } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { config } from "../config";
import { getRedis } from "../lib/redis";
import {
  assertSessionEpoch,
  getSessionEpoch,
  parseEpochClaim,
} from "../lib/sessionEpoch";
import { AppError } from "../middleware/envelope";

// ============================================
// JWT Strategy (EGS 2.3)
// Access  : 15 min TTL (JWT_SECRET)
// Refresh : 7 day TTL  (JWT_REFRESH_SECRET), HttpOnly cookie
// Rotation: old refresh blacklisted by jti before issuing new pair
// Device  : device_fingerprint claim; mismatch -> step-up auth required
// ============================================

export interface AuthClaims {
  sub: string; // user id
  phone: string;
  role: string;
  device_fingerprint: string;
  type: "access" | "refresh" | "totp_ticket";
  jti?: string;
  session_epoch?: number;
}

export type SignableClaims = Omit<AuthClaims, "type" | "jti">;

const REFRESH_BLACKLIST_PREFIX = "jwt:blacklist:";
const TOTP_TICKET_TTL_SECONDS = 300;

function toAuthClaims(payload: JwtPayload): AuthClaims {
  const { sub, phone, role, device_fingerprint, type, jti, session_epoch } = payload;
  if (
    typeof sub !== "string" ||
    sub.length === 0 ||
    typeof phone !== "string" ||
    phone.length === 0 ||
    typeof role !== "string" ||
    role.length === 0 ||
    typeof device_fingerprint !== "string" ||
    typeof type !== "string"
  ) {
    throw new AppError(
      "INVALID_TOKEN",
      "Token is missing required claims",
      401,
    );
  }
  if (type !== "access" && type !== "refresh" && type !== "totp_ticket") {
    throw new AppError("INVALID_TOKEN", "Invalid token type claim", 401);
  }
  const claims: AuthClaims = {
    sub,
    phone,
    role,
    device_fingerprint,
    type,
    jti: typeof jti === "string" ? jti : undefined,
  };
  if (type === "access" || type === "refresh") {
    claims.session_epoch = parseEpochClaim(session_epoch);
  }
  return claims;
}

function withSessionEpoch(claims: SignableClaims, session_epoch: number): SignableClaims {
  return { ...claims, session_epoch };
}

export class JwtService {
  signAccessToken(claims: SignableClaims): string {
    const { sub, session_epoch, ...rest } = claims;
    return jwt.sign(
      {
        ...rest,
        type: "access",
        jti: randomUUID(),
        session_epoch: session_epoch ?? 0,
      },
      config.jwt.accessSecret,
      {
        subject: sub,
        expiresIn: config.jwt.accessTtlSeconds,
        issuer: "snakzap",
      },
    );
  }

  signRefreshToken(claims: SignableClaims): {
    token: string;
    jti: string;
  } {
    const jti = randomUUID();
    const { sub, session_epoch, ...rest } = claims;
    const token = jwt.sign(
      {
        ...rest,
        type: "refresh",
        jti,
        session_epoch: session_epoch ?? 0,
      },
      config.jwt.refreshSecret,
      {
        subject: sub,
        expiresIn: config.jwt.refreshTtlSeconds,
        issuer: "snakzap",
      },
    );
    return { token, jti };
  }

  verifyAccessToken(token: string): AuthClaims {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, config.jwt.accessSecret, {
        algorithms: ["HS256"],
        issuer: "snakzap",
      }) as JwtPayload;
    } catch (err) {
      throw this.toTokenError(err);
    }
    const claims = toAuthClaims(payload);
    if (claims.type !== "access") {
      throw new AppError("INVALID_TOKEN", "Not an access token", 401);
    }
    return claims;
  }

  verifyRefreshToken(token: string): AuthClaims {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, config.jwt.refreshSecret, {
        algorithms: ["HS256"],
        issuer: "snakzap",
      }) as JwtPayload;
    } catch (err) {
      throw this.toTokenError(err);
    }
    const claims = toAuthClaims(payload);
    if (claims.type !== "refresh" || !claims.jti) {
      throw new AppError("INVALID_TOKEN", "Not a refresh token", 401);
    }
    return claims;
  }

  /**
   * 2FA step-up: short-lived single-purpose ticket minted after OTP passes,
   * consumed by the TOTP verify endpoint to prove the authenticator factor.
   */
  signTotpTicket(claims: SignableClaims): string {
    const { sub, ...rest } = claims;
    return jwt.sign(
      { ...rest, type: "totp_ticket", jti: randomUUID() },
      config.jwt.accessSecret,
      {
        subject: sub,
        expiresIn: TOTP_TICKET_TTL_SECONDS,
        issuer: "snakzap",
      },
    );
  }

  verifyTotpTicket(token: string): AuthClaims {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, config.jwt.accessSecret, {
        algorithms: ["HS256"],
        issuer: "snakzap",
      }) as JwtPayload;
    } catch (err) {
      throw this.toTokenError(err);
    }
    const claims = toAuthClaims(payload);
    if (claims.type !== "totp_ticket") {
      throw new AppError("INVALID_TOKEN", "Not a 2FA ticket", 401);
    }
    return claims;
  }

  private toTokenError(err: unknown): AppError {
    const name = err instanceof Error ? err.name : "";
    if (name === "TokenExpiredError") {
      return new AppError("TOKEN_EXPIRED", "Token has expired", 401);
    }
    return new AppError("INVALID_TOKEN", "Invalid or malformed token", 401);
  }

  async blacklistRefreshToken(jti: string): Promise<void> {
    const redis = getRedis();
    await redis.set(
      `${REFRESH_BLACKLIST_PREFIX}${jti}`,
      "1",
      "PX",
      config.jwt.refreshTtlSeconds * 1000,
    );
  }

  async isRefreshTokenBlacklisted(jti: string): Promise<boolean> {
    const redis = getRedis();
    return (await redis.get(`${REFRESH_BLACKLIST_PREFIX}${jti}`)) !== null;
  }

  async issuePair(claims: SignableClaims): Promise<{
    accessToken: string;
    refreshToken: string;
    refreshJti: string;
  }> {
    const session_epoch =
      claims.session_epoch !== undefined
        ? parseEpochClaim(claims.session_epoch)
        : await getSessionEpoch(claims.sub);
    const stamped = withSessionEpoch(claims, session_epoch);
    const accessToken = this.signAccessToken(stamped);
    const { token: refreshToken, jti } = this.signRefreshToken(stamped);
    return { accessToken, refreshToken, refreshJti: jti };
  }

  /**
   * Refresh rotation:
   * 1. verify old refresh token
   * 2. reject if already blacklisted (reuse detection)
   * 3. enforce device binding - mismatched device requires step-up auth
   * 4. blacklist old jti, issue new pair
   */
  async rotateRefreshToken(
    oldToken: string,
    device_fingerprint: string,
  ): Promise<{ accessToken: string; refreshToken: string; refreshJti: string }> {
    const claims = this.verifyRefreshToken(oldToken);

    if (await this.isRefreshTokenBlacklisted(claims.jti!)) {
      throw new AppError(
        "REFRESH_TOKEN_REUSED",
        "Refresh token reuse detected. Re-authentication required.",
        401,
      );
    }

    if (claims.device_fingerprint !== device_fingerprint) {
      throw new AppError(
        "DEVICE_MISMATCH",
        "New device detected. Step-up authentication (OTP) required.",
        401,
      );
    }

    await assertSessionEpoch(claims.sub, parseEpochClaim(claims.session_epoch));

    await this.blacklistRefreshToken(claims.jti!);

    return this.issuePair({
      sub: claims.sub,
      phone: claims.phone,
      role: claims.role,
      device_fingerprint,
      session_epoch: claims.session_epoch,
    });
  }
}

export const jwtService = new JwtService();
