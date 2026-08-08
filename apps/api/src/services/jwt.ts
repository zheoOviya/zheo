import { randomUUID } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { config } from "../config";
import { getRedis } from "../lib/redis";
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
  type: "access" | "refresh";
  jti?: string;
}

const REFRESH_BLACKLIST_PREFIX = "jwt:blacklist:";

function toAuthClaims(payload: JwtPayload): AuthClaims {
  return {
    sub: payload.sub as string,
    phone: payload.phone as string,
    role: payload.role as string,
    device_fingerprint: payload.device_fingerprint as string,
    type: payload.type as "access" | "refresh",
    jti: payload.jti as string | undefined,
  };
}

export class JwtService {
  signAccessToken(claims: Omit<AuthClaims, "type" | "jti">): string {
    const { sub, ...rest } = claims;
    return jwt.sign(
      { ...rest, type: "access", jti: randomUUID() },
      config.jwt.accessSecret,
      {
        subject: sub,
        expiresIn: config.jwt.accessTtlSeconds,
        issuer: "snakzap",
      },
    );
  }

  signRefreshToken(claims: Omit<AuthClaims, "type" | "jti">): {
    token: string;
    jti: string;
  } {
    const jti = randomUUID();
    const { sub, ...rest } = claims;
    const token = jwt.sign(
      { ...rest, type: "refresh", jti },
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

  issuePair(claims: Omit<AuthClaims, "type" | "jti">): {
    accessToken: string;
    refreshToken: string;
    refreshJti: string;
  } {
    const accessToken = this.signAccessToken(claims);
    const { token: refreshToken, jti } = this.signRefreshToken(claims);
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

    await this.blacklistRefreshToken(claims.jti!);

    return this.issuePair({
      sub: claims.sub,
      phone: claims.phone,
      role: claims.role,
      device_fingerprint,
    });
  }
}

export const jwtService = new JwtService();
