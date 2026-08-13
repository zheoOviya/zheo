import { describe, expect, it } from "vitest";
import {
  buildOtpauthUrl,
  generateTotpCode,
  generateTotpSecret,
  verifyTotpCode,
} from "./totp";

describe("TOTP (RFC 6238)", () => {
  it("generates a base32 secret of the right shape", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it("round-trips a valid code within the current window", () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(verifyTotpCode(secret, code)).toBe(true);
  });

  it("rejects a wrong code", () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    const wrong = code === "000000" ? "111111" : "000000";
    expect(verifyTotpCode(secret, wrong)).toBe(false);
  });

  it("rejects malformed codes", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "12345")).toBe(false);
    expect(verifyTotpCode(secret, "abcdef")).toBe(false);
    expect(verifyTotpCode(secret, "")).toBe(false);
  });

  it("tolerates a neighbouring time step (clock drift)", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const prev = generateTotpCode(secret, now - 30_000);
    expect(verifyTotpCode(secret, prev, now)).toBe(true);
    const next = generateTotpCode(secret, now + 30_000);
    expect(verifyTotpCode(secret, next, now)).toBe(true);
  });

  it("builds a well-formed otpauth URL", () => {
    const url = buildOtpauthUrl("JBSWY3DPEHPK3PXP", "admin@snakzap", "SnakZap");
    expect(url).toContain("otpauth://totp/");
    expect(url).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(url).toContain("issuer=SnakZap");
    expect(url).toContain("algorithm=SHA1");
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
  });

  // RFC 6238 Appendix B test vectors (SHA1). The official vectors are 8-digit;
  // our config is 6-digit, so we compare the same truncated value mod 10^6.
  it("matches the RFC 6238 SHA1 test vectors (6-digit truncation)", () => {
    // Secret "12345678901234567890" -> base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [timestamp, expected8] of vectors) {
      const expected6 = String(Number(expected8) % 1_000_000).padStart(6, "0");
      expect(generateTotpCode(secret, timestamp * 1000)).toBe(expected6);
    }
  });
});
