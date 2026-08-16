"use client";

// ============================================
// Vendor session management.
// The access token now lives in an httpOnly cookie
// (snakzap_access) set by the API, so it is never
// persisted to localStorage. This module mirrors the
// current user in memory (for UI decisions) and
// hydrates it from GET /api/v1/auth/me on load. The
// refresh token stays in the httpOnly snakzap_refresh
// cookie and is used to silently rotate the access
// token on 401.
// ============================================

const FP_KEY = "snkz_vendor_fp";

let accessToken: string | null = null;
let sessionUser: VendorSessionUser | null = null;

export interface VendorSessionUser {
  id: string;
  phone: string;
  role: string;
  is_suspended?: boolean;
}

export function storeSession(accessTokenValue: string, user: VendorSessionUser): void {
  accessToken = accessTokenValue;
  sessionUser = user;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getSessionUser(): VendorSessionUser | null {
  return sessionUser;
}

export function isAuthenticated(): boolean {
  return sessionUser !== null;
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
  accessToken = null;
  sessionUser = null;
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
  accessToken = token;
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

// Hydrates the in-memory session from the httpOnly access cookie. Returns the
// user on success, or null when there is no valid session. Idempotent and safe
// to call on every mount (covers hard reloads where module state is empty).
let hydrateInFlight: Promise<VendorSessionUser | null> | null = null;

export function hydrateSession(): Promise<VendorSessionUser | null> {
  if (hydrateInFlight) return hydrateInFlight;
  hydrateInFlight = doHydrate().finally(() => {
    hydrateInFlight = null;
  });
  return hydrateInFlight;
}

async function doHydrate(): Promise<VendorSessionUser | null> {
  try {
    const res = await fetch("/api/v1/auth/me", { credentials: "include" });
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: {
        user?: { id?: string; phone?: string; role?: string; is_suspended?: boolean };
      };
    } | null;
    const user = body?.success ? body.data?.user : null;
    if (!user?.role) return null;
    sessionUser = {
      id: user.id ?? "",
      phone: user.phone ?? "",
      role: user.role,
      is_suspended: user.is_suspended,
    };
    return sessionUser;
  } catch {
    return null;
  }
}
