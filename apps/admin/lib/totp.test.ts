import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmTotp,
  disableTotp,
  enrollTotp,
  getTotpStatus,
  verifyTotpLogin,
} from "./totp";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("admin totp client lib", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("getTotpStatus POSTs with the httpOnly cookie and returns status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { totp_enabled: true, enrolled: true, totp_confirmed_at: null },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const status = await getTotpStatus();
    expect(status.totp_enabled).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/totp/status");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });

  it("enrollTotp returns the secret and otpauth URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: true,
            data: { secret: "ABCDEFGH", otpauth_url: "otpauth://totp/SnakZap:x?secret=ABCDEFGH" },
          },
          201,
        ),
      ),
    );
    const result = await enrollTotp();
    expect(result.secret).toBe("ABCDEFGH");
    expect(result.otpauth_url).toContain("otpauth://totp/");
  });

  it("confirmTotp sends the code in the JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { totp_enabled: true, totp_confirmed_at: "x" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await confirmTotp("123456");
    expect(res.totp_enabled).toBe(true);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ code: "123456" });
  });

  it("disableTotp sends the code and returns disabled state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { totp_enabled: false } })),
    );
    const res = await disableTotp("654321");
    expect(res.totp_enabled).toBe(false);
  });

  it("verifyTotpLogin completes the 2-step login with a valid ticket", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          access_token: "jwt",
          expires_in: 900,
          user: { id: "u1", phone: "+911234567890", role: "ADMIN" },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await verifyTotpLogin({
      totp_ticket: "ticket-abc",
      code: "111111",
      device_fingerprint: "fp-device-a-1234567890",
      phone: "+911234567890",
    });
    expect(res.access_token).toBe("jwt");
    expect(res.user.role).toBe("ADMIN");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/totp/verify");
    expect(JSON.parse(String(init.body))).toMatchObject({
      totp_ticket: "ticket-abc",
      code: "111111",
      phone: "+911234567890",
    });
  });

  it("throws a friendly error when the API returns an error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { success: false, error: { code: "INVALID_TOTP", message: "Invalid authenticator code" } },
          401,
        ),
      ),
    );
    await expect(verifyTotpLogin({
      totp_ticket: "t",
      code: "000000",
      device_fingerprint: "fp-device-a-1234567890",
      phone: "+911234567890",
    })).rejects.toThrow("Invalid authenticator code");
  });
});
