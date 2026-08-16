// ============================================
// WebSocket URL resolution (vendor + consumer).
//
// Strategy (preview + production aware):
//   1. NEXT_PUBLIC_WS_URL  - explicit full WS URL override (legacy).
//   2. NEXT_PUBLIC_API_BASE - API origin; derives ws(s)://<host> from it.
//   3. Browser (preview)    - same-origin host, so the frontend's reverse
//                             proxy forwards the WS upgrade to the API.
//   4. SSR fallback         - loopback; never used to open a real socket
//                             (connect happens in a client-only effect).
// ============================================

export function getWsUrl(path: string): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;

  const apiBase = process.env.NEXT_PUBLIC_API_BASE;
  if (apiBase) {
    const url = new URL(apiBase);
    const proto = url.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${url.host}${path}`;
  }

  if (typeof window !== "undefined" && window.location?.host) {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}${path}`;
  }

  return `ws://127.0.0.1:3001${path}`;
}
