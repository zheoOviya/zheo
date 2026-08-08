const TOKEN_KEY = "snkz_admin_token";
const ROLE_KEY = "snkz_admin_role";

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

export function storeSession(accessToken: string): void {
  localStorage.setItem(TOKEN_KEY, accessToken);
  const payload = parseJwtPayload(accessToken);
  if (payload?.role) {
    localStorage.setItem(ROLE_KEY, payload.role as string);
  }
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getUserRole(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ROLE_KEY);
}

export function isAdmin(): boolean {
  const role = getUserRole();
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
}

// Server-side sign out. The admin login stores the JWT in localStorage AND the
// API sets an httpOnly refresh-token cookie (path /api/v1/auth). Signing out
// must (a) call POST /api/v1/auth/logout so the refresh-token JTI is
// blacklisted and the cookie is cleared, and (b) drop the local session.
// The server call is best-effort: the local session is always cleared even if
// the network fails (e.g. the API is unreachable).
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
