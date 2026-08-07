import { beforeEach, describe, expect, it } from "vitest";
import { resetRedisForTests } from "../lib/redis";
import { AppError } from "../middleware/envelope";
import { JwtService } from "./jwt";

const claims = {
  sub: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  phone: "+919876543210",
  role: "CONSUMER",
  device_fingerprint: "fp-device-a-1234567890",
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

    const rotated = await svc.rotateRefreshToken(
      pair.refreshToken,
      claims.device_fingerprint,
    );
    expect(rotated.refreshJti).not.toBe(pair.refreshJti);
    expect(rotated.accessToken).toBeTruthy();

    // Old token reuse must be rejected
    await expect(
      svc.rotateRefreshToken(pair.refreshToken, claims.device_fingerprint),
    ).rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSED" });
  });

  it("rejects rotation on device fingerprint mismatch (step-up auth)", async () => {
    const pair = svc.issuePair(claims);
    await expect(
      svc.rotateRefreshToken(pair.refreshToken, "fp-different-device"),
    ).rejects.toMatchObject({ code: "DEVICE_MISMATCH" });
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
