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
