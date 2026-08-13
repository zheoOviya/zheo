import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAdminOtp, verifyAdminOtp } from "./authFlow";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("admin email login client lib", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sendAdminOtp posts the email and returns the masked phone + demo OTP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { sent: true, phoneMasked: "+9****00", expiresInSeconds: 300, demoOtp: "123456" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendAdminOtp("admin@snakzap.dev");
    expect(result.phoneMasked).toBe("+9****00");
    expect(result.demoOtp).toBe("123456");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/admin/send-otp");
    expect(JSON.parse(String(init.body))).toEqual({ email: "admin@snakzap.dev" });
  });

  it("verifyAdminOtp returns tokens on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          data: {
            access_token: "jwt",
            expires_in: 900,
            user: { id: "u1", phone: "+919876000000", role: "ADMIN" },
          },
        }),
      ),
    );

    const result = await verifyAdminOtp({
      email: "admin@snakzap.dev",
      otp: "123456",
      device_fingerprint: "fp-admin-000000000001",
    });
    expect(result.access_token).toBe("jwt");
    expect(result.user?.role).toBe("ADMIN");
    expect(result.totp_required).toBeUndefined();
  });

  it("verifyAdminOtp surfaces the 2FA ticket + phone when TOTP is required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: true,
            data: { totp_required: true, totp_ticket: "ticket", phone: "+919876000000" },
          },
          202,
        ),
      ),
    );

    const result = await verifyAdminOtp({
      email: "superadmin@snakzap.dev",
      otp: "654321",
      device_fingerprint: "fp-admin-000000000001",
    });
    expect(result.totp_required).toBe(true);
    expect(result.totp_ticket).toBe("ticket");
    expect(result.phone).toBe("+919876000000");
  });

  it("throws the API error message on rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { success: false, error: { code: "FORBIDDEN", message: "Unknown email or not an operator account" } },
          403,
        ),
      ),
    );
    await expect(sendAdminOtp("nobody@snakzap.dev")).rejects.toThrow(
      "Unknown email or not an operator account",
    );
  });
});
