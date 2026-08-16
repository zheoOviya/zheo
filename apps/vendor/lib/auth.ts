"use client";

// ============================================
// Vendor session management.
// The login page completes phone+OTP and stores
// the access token + user (localStorage). The
// refresh token lives in an httpOnly cookie set
// by the API (snakzap_refresh) and is used to
// silently rotate the access token on 401.
// ============================================

const TOKEN_KEY = "snkz_vendor_token";
const USER_KEY = "snkz_vendor_user";
const FP_KEY = "snkz_vendor_fp";

export interface VendorSessionUser {
  id: string;
  phone: string;
  role: string;
  is_suspended?: boolean;
}

export function storeSession(accessToken: string, user: VendorSessionUser): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getSessionUser(): VendorSessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VendorSessionUser;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return getAccessToken() !== null;
}

export function getDeviceFingerprint(): string {
  if (typeof window === "undefined") return "vendor-web-0000000001";
  let fp = localStorage.getItem(FP_KEY);
  if (!fp) {
    fp = `vendor-web-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(FP_KEY, fp);
  }
  return fp;
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Silently rotates the access token using the httpOnly refresh cookie. */
let refreshInFlight: Promise<string | null> | null = null;

export function refreshSession(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshSession().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefreshSession(): Promise<string | null> {
  const res = await fetch("/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ device_fingerprint: getDeviceFingerprint() }),
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: { access_token?: string };
  } | null;
  if (!body?.success || !body.data?.access_token) return null;
  const token = body.data.access_token;
  localStorage.setItem(TOKEN_KEY, token);
  return token;
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // Best-effort server-side logout; local session cleared below.
  } finally {
    clearSession();
  }
}
