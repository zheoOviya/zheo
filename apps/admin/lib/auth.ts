// ============================================
// Admin console session management.
// The access token now lives in an httpOnly cookie
// (snakzap_access) set by the API, so it is never
// persisted to localStorage or readable by page
// JavaScript. This module only mirrors the current
// user's id + role in memory (for UI decisions) and
// hydrates them from GET /api/v1/auth/me on load.
// ============================================

let accessToken: string | null = null;
let currentUserId: string | null = null;
let currentRole: string | null = null;

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const base64 = token.split(".")[1];
    if (!base64) return null;
    const json = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function storeSession(token: string): void {
  accessToken = token;
  const payload = parseJwtPayload(token);
  currentUserId = (payload?.sub as string | null) ?? null;
  currentRole = (payload?.role as string | null) ?? null;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getUserRole(): string | null {
  return currentRole;
}

export function isAdmin(): boolean {
  const role = currentRole;
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}

/** Whether the current role may change another user's role (SUPER_ADMIN only). */
export function canChangeRole(actorRole: string | null): boolean {
  return actorRole === "SUPER_ADMIN";
}

/** Whether the actor may suspend/reactivate the given target, mirroring the
 *  API hierarchy: no self-service, ADMIN cannot touch operators, SUPER_ADMIN
 *  cannot touch another SUPER_ADMIN. */
export function canToggleSuspension(
  actorRole: string | null,
  actorId: string | null,
  targetRole: string,
  targetId: string,
): boolean {
  if (actorId && actorId === targetId) return false;
  if (actorRole === "SUPER_ADMIN") return targetRole !== "SUPER_ADMIN";
  if (actorRole === "ADMIN") return targetRole !== "ADMIN" && targetRole !== "SUPER_ADMIN";
  return false;
}

export function clearSession(): void {
  accessToken = null;
  currentUserId = null;
  currentRole = null;
}

// Server-side sign out. Signing out must (a) call POST /api/v1/auth/logout so
// the refresh-token JTI is blacklisted and both cookies are cleared, and (b)
// drop the in-memory session. The server call is best-effort: the local
// session is always cleared even if the network fails.
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

// Hydrates the in-memory role/user from the httpOnly access cookie. Returns
// the role on success, or null when there is no valid session. Idempotent and
// safe to call on every mount (e.g. hard reloads where module state is empty).
let hydrateInFlight: Promise<string | null> | null = null;

export function hydrateSession(): Promise<string | null> {
  if (hydrateInFlight) return hydrateInFlight;
  hydrateInFlight = doHydrate().finally(() => {
    hydrateInFlight = null;
  });
  return hydrateInFlight;
}

async function doHydrate(): Promise<string | null> {
  try {
    const res = await fetch("/api/v1/auth/me", { credentials: "include" });
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: { user?: { id?: string; role?: string; is_suspended?: boolean } };
    } | null;
    const user = body?.success ? body.data?.user : null;
    if (!user?.role) return null;
    currentUserId = user.id ?? null;
    currentRole = user.role;
    return user.role;
  } catch {
    return null;
  }
}
