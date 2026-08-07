import { describe, expect, it } from "vitest";

function parseJwtExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const body = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(body));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function base64url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeToken(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

describe("Admin Middleware (A-01)", () => {
  describe("parseJwtExp", () => {
    it("returns null for empty token", () => {
      expect(parseJwtExp("")).toBeNull();
    });

    it("returns null for malformed token (no dots)", () => {
      expect(parseJwtExp("abcdef")).toBeNull();
    });

    it("returns null for invalid base64 payload", () => {
      expect(parseJwtExp("header.invalid!!!.sig")).toBeNull();
    });

    it("returns exp when valid token with exp claim", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = makeToken({ exp: now + 3600, role: "ADMIN" });
      const result = parseJwtExp(token);
      expect(result).toBe(now + 3600);
    });

    it("returns null when token has no exp claim", () => {
      const token = makeToken({ role: "ADMIN", sub: "user-123" });
      expect(parseJwtExp(token)).toBeNull();
    });

    it("returns null when exp is not a number", () => {
      const token = makeToken({ exp: "not-a-number" });
      expect(parseJwtExp(token)).toBeNull();
    });
  });

  describe("middleware logic (extracted)", () => {
    function shouldRedirect(tokenCookie: string | undefined): boolean {
      if (!tokenCookie) return true;
      const exp = parseJwtExp(tokenCookie);
      if (exp === null) return true;
      if (exp * 1000 < Date.now()) return true;
      return false;
    }

    it("redirects when no cookie present", () => {
      expect(shouldRedirect(undefined)).toBe(true);
    });

    it("redirects when cookie is empty string", () => {
      expect(shouldRedirect("")).toBe(true);
    });

    it("redirects when token has expired", () => {
      const expiredToken = makeToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
      expect(shouldRedirect(expiredToken)).toBe(true);
    });

    it("redirects when token has expired (exactly at expiry)", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = makeToken({ exp: now });
      expect(shouldRedirect(token)).toBe(true);
    });

    it("allows when token is valid (future exp)", () => {
      const validToken = makeToken({ exp: Math.floor(Date.now() / 1000) + 3600 });
      expect(shouldRedirect(validToken)).toBe(false);
    });

    it("redirects when exp is null (missing)", () => {
      const token = makeToken({ role: "ADMIN" });
      expect(shouldRedirect(token)).toBe(true);
    });
  });
});
