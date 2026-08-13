"use client";

// ============================================
// Admin console login flow (email -> OTP on linked mobile -> TOTP)
// ============================================

export interface SendAdminOtpResult {
  sent: boolean;
  phoneMasked: string;
  expiresInSeconds: number;
  demoOtp?: string;
}

export interface VerifyAdminOtpResult {
  access_token?: string;
  expires_in?: number;
  user?: { id: string; phone: string; role: string };
  totp_required?: boolean;
  totp_ticket?: string;
  phone?: string;
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

export async function sendAdminOtp(email: string): Promise<SendAdminOtpResult> {
  const res = await fetch("/api/v1/auth/admin/send-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return readJson<SendAdminOtpResult>(res);
}

export async function verifyAdminOtp(input: {
  email: string;
  otp: string;
  device_fingerprint: string;
}): Promise<VerifyAdminOtpResult> {
  const res = await fetch("/api/v1/auth/admin/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<VerifyAdminOtpResult>(res);
}
