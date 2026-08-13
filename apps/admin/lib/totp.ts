"use client";

// ============================================
// TOTP 2FA client (apps/admin)
// Talks to the API auth router's /totp/* endpoints.
// ============================================

export interface TotpStatus {
  totp_enabled: boolean;
  enrolled: boolean;
  totp_confirmed_at: string | null;
}

export interface TotpEnrollResult {
  secret: string;
  otpauth_url: string;
}

export interface TotpVerifyResult {
  access_token: string;
  expires_in: number;
  user: { id: string; phone: string; role: string };
}

function bearerHeaders(token?: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function readJson<T>(res: Response): Promise<T> {
  let body: { success: boolean; data?: T; error?: { message?: string } };
  try {
    body = await res.json();
  } catch {
    throw new Error("Unexpected server response");
  }
  if (!body.success || body.data === null || body.data === undefined) {
    throw new Error(body.error?.message ?? "Request failed");
  }
  return body.data;
}

export async function getTotpStatus(token: string): Promise<TotpStatus> {
  const res = await fetch("/api/v1/auth/totp/status", {
    method: "POST",
    headers: bearerHeaders(token),
  });
  return readJson<TotpStatus>(res);
}

export async function enrollTotp(token: string): Promise<TotpEnrollResult> {
  const res = await fetch("/api/v1/auth/totp/enroll", {
    method: "POST",
    headers: bearerHeaders(token),
  });
  return readJson<TotpEnrollResult>(res);
}

export async function confirmTotp(
  token: string,
  code: string,
): Promise<{ totp_enabled: boolean; totp_confirmed_at: string }> {
  const res = await fetch("/api/v1/auth/totp/confirm", {
    method: "POST",
    headers: bearerHeaders(token),
    body: JSON.stringify({ code }),
  });
  return readJson(res);
}

export async function disableTotp(
  token: string,
  code: string,
): Promise<{ totp_enabled: boolean }> {
  const res = await fetch("/api/v1/auth/totp/disable", {
    method: "POST",
    headers: bearerHeaders(token),
    body: JSON.stringify({ code }),
  });
  return readJson(res);
}

/** Completes 2-step login after the OTP factor issued a TOTP ticket. */
export async function verifyTotpLogin(input: {
  totp_ticket: string;
  code: string;
  device_fingerprint: string;
  phone: string;
}): Promise<TotpVerifyResult> {
  const res = await fetch("/api/v1/auth/totp/verify", {
    method: "POST",
    headers: bearerHeaders(),
    body: JSON.stringify(input),
  });
  return readJson<TotpVerifyResult>(res);
}
