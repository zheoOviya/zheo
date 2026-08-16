import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ============================================
// Next.js Middleware - Protected Route Gate
// Checks snakzap_refresh HttpOnly cookie as auth proxy.
// Edge-runtime: can read cookies from incoming requests.
// If no refresh cookie -> redirect to /login.
// ============================================

const REFRESH_COOKIE = "snakzap_refresh";
const LOGIN_PATH = "/login";

export function middleware(request: NextRequest) {
  const refreshCookie = request.cookies.get(REFRESH_COOKIE);

  if (!refreshCookie?.value) {
    const loginUrl = new URL(LOGIN_PATH, request.url);
    loginUrl.searchParams.set("from", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/checkout", "/orders/:path*", "/profile", "/addresses"],
};
