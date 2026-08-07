"use client";

// ============================================
// Phase 4 demo auth (apps/vendor)
// The chain endpoints are role-gated and catering is auth-gated, so the
// vendor app silently performs the demo OTP login (dev OTP 111111 accepted
// in non-production) and caches the Bearer token for the session.
// ============================================

const DEMO_PHONE = "+919876000001"; // seeded VENDOR_OWNER (Chain Owner)
const DEVICE_FP = "vendor-demo-fp-0001";

let cachedToken: string | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  await fetch("/api/v1/auth/send-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: DEMO_PHONE }),
  });

  const res = await fetch("/api/v1/auth/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: DEMO_PHONE,
      otp: "111111",
      device_fingerprint: DEVICE_FP,
    }),
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(body.error?.message ?? "Demo login failed");
  }
  const token = body.data.access_token as string;
  cachedToken = token;
  return token;
}

export async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken();
  return fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}
