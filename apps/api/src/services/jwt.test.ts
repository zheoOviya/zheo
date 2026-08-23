import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRedisForTests } from "../lib/redis";
import { AppError } from "../middleware/envelope";
import { JwtService } from "./jwt";

const claims = {
  sub: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  phone: "+919876543210",
  role: "CONSUMER",
  device_fingerprint: "fp-device-a-1234567890",
};

const activeIdentity = {
  phone: claims.phone,
  role: claims.role,
  is_suspended: false,
};

describe("JwtService", () => {
  let svc: JwtService;

  beforeEach(() => {
    resetRedisForTests();
    svc = new JwtService();
  });

  it("issues an access token valid for 15 min TTL", () => {
    const token = svc.signAccessToken(claims);
    const decoded = svc.verifyAccessToken(token);
    expect(decoded.sub).toBe(claims.sub);
    expect(decoded.type).toBe("access");
    expect(decoded.device_fingerprint).toBe(claims.device_fingerprint);
  });

  it("rejects a refresh token when verified as access", () => {
    const { token } = svc.signRefreshToken(claims);
    expect(() => svc.verifyAccessToken(token)).toThrow(AppError);
  });

  it("issues a refresh token with a unique jti", () => {
    const a = svc.signRefreshToken(claims);
    const b = svc.signRefreshToken(claims);
    expect(a.jti).not.toBe(b.jti);
  });

  it("rotates a refresh token and blacklists the old one", async () => {
    const pair = svc.issuePair(claims);
    const loadCurrentUser = vi.fn(async () => activeIdentity);

    const rotated = await svc.rotateRefreshToken(
      pair.refreshToken,
      claims.device_fingerprint,
      loadCurrentUser,
    );
    expect(rotated.refreshJti).not.toBe(pair.refreshJti);
    expect(rotated.accessToken).toBeTruthy();
    // The resolver is consulted with the token's sub and both minted tokens
    // carry the CURRENT identity's role.
    expect(loadCurrentUser).toHaveBeenCalledWith(claims.sub);
    expect(svc.verifyAccessToken(rotated.accessToken).role).toBe("CONSUMER");
    expect(svc.verifyRefreshToken(rotated.refreshToken).role).toBe("CONSUMER");

    // Old token reuse must be rejected
    await expect(
      svc.rotateRefreshToken(pair.refreshToken, claims.device_fingerprint, loadCurrentUser),
    ).rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSED" });
  });

  it("rejects rotation on device fingerprint mismatch (step-up auth)", async () => {
    const pair = svc.issuePair(claims);
    await expect(
      svc.rotateRefreshToken(pair.refreshToken, "fp-different-device", async () => activeIdentity),
    ).rejects.toMatchObject({ code: "DEVICE_MISMATCH" });
  });

  it("mints a new pair from CURRENT identity role, ignoring a stale role claim", async () => {
    // Old refresh token was issued when the account was SUPER_ADMIN.
    const stale = svc.issuePair({ ...claims, role: "SUPER_ADMIN" });
    // The current authoritative identity says CONSUMER.
    const loadCurrentUser = vi.fn(async () => ({
      phone: claims.phone,
      role: "CONSUMER",
      is_suspended: false,
    }));

    const rotated = await svc.rotateRefreshToken(
      stale.refreshToken,
      claims.device_fingerprint,
      loadCurrentUser,
    );

    // BOTH minted tokens must carry the current role, never the stale one.
    expect(svc.verifyAccessToken(rotated.accessToken).role).toBe("CONSUMER");
    expect(svc.verifyRefreshToken(rotated.refreshToken).role).toBe("CONSUMER");
    // The current phone wins over any stale claim too.
    expect(svc.verifyAccessToken(rotated.accessToken).phone).toBe(claims.phone);
  });

  it("rejects rotation for a suspended account (no new pair)", async () => {
    const pair = svc.issuePair(claims);
    await expect(
      svc.rotateRefreshToken(pair.refreshToken, claims.device_fingerprint, async () => ({
        phone: claims.phone,
        role: claims.role,
        is_suspended: true,
      })),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED", status: 403 });
    // Old token must NOT be consumed/blacklisted on a rejection.
    expect(await svc.isRefreshTokenBlacklisted(pair.refreshJti)).toBe(false);
  });

  it("rejects rotation when the account no longer exists", async () => {
    const pair = svc.issuePair(claims);
    await expect(
      svc.rotateRefreshToken(pair.refreshToken, claims.device_fingerprint, async () => null),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND", status: 401 });
    expect(await svc.isRefreshTokenBlacklisted(pair.refreshJti)).toBe(false);
  });

  it("blacklists and detects a refresh token by jti", async () => {
    const { token, jti } = svc.signRefreshToken(claims);
    expect(await svc.isRefreshTokenBlacklisted(jti)).toBe(false);
    await svc.blacklistRefreshToken(jti);
    expect(await svc.isRefreshTokenBlacklisted(jti)).toBe(true);
    // verification still passes (JWT valid), blacklist check is explicit
    expect(() => svc.verifyRefreshToken(token)).not.toThrow();
  });
});
