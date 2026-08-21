"use client";

import { useEffect, useRef, useState } from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sheet } from "@snakzap/ui";
import { useAuthStore } from "@/lib/store";
import { useMediaQuery } from "@/hooks/useMediaQuery";

// ============================================
// Header account entry point.
// Unauthenticated visitors see prominent Sign in / Sign up links;
// signed-in users see an account menu (profile, order history,
// saved addresses, sign out). A suspended account shows a clear
// warning banner. On mount we attempt a silent refresh so a
// returning user with a valid refresh cookie is recognized
// without an explicit sign-in.
//
// On desktop the menu is a dropdown with menu/menuitem semantics;
// on mobile it becomes a bottom-sheet dialog with large touch
// targets (44px minimum) for easier one-handed navigation.
// ============================================

const DESKTOP_QUERY = "(min-width: 768px)";

const accountLinks = [
  { href: "/profile", label: "Your profile" },
  { href: "/orders", label: "Order history" },
  { href: "/addresses", label: "Saved addresses" },
];

function SuspensionBanner() {
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-red-600 px-4 py-2.5 text-center text-sm font-semibold text-white"
    >
      <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
      Your account has been suspended. Please contact support for help.
    </div>
  );
}

export function AccountEntry() {
  const router = useRouter();
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const refreshAccessToken = useAuthStore((s) => s.refreshAccessToken);
  const logout = useAuthStore((s) => s.logout);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  useEffect(() => {
    setMounted(true);
    // Ensure the session user is hydrated on every hard load. AuthGate only
    // wraps protected pages, so on public routes (e.g. home) this header is
    // the only component that can refresh the cookie session and then fetch
    // the current user (including suspension state) for the banner.
    const state = useAuthStore.getState();
    const ready = state.accessToken ? Promise.resolve(true) : state.refreshAccessToken();
    ready.then(() => state.fetchMe()).catch(() => {});
  }, [refreshAccessToken]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (!mounted) {
    return <div aria-hidden="true" className="h-9 w-9 rounded-full bg-neutral-200" />;
  }

  async function handleSignOut() {
    await logout();
    router.push("/login");
    router.refresh();
  }

  const avatarButton = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-label="Account menu"
      aria-haspopup={isDesktop ? "menu" : "dialog"}
      aria-expanded={open}
      aria-controls={isDesktop ? "account-menu" : undefined}
      className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-sm font-bold text-white shadow-md shadow-primary-700/20 transition-transform hover:scale-105 active:scale-95"
    >
      U
    </button>
  );

  if (accessToken) {
    if (isDesktop) {
      return (
        <>
          {user?.is_suspended && <SuspensionBanner />}
          <div ref={menuRef} className="relative">
            {avatarButton}
            {open && (
              <div
                id="account-menu"
                role="menu"
                className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
              >
                {accountLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className="block px-4 py-2.5 text-sm text-neutral-700 hover:bg-surface-light dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    {link.label}
                  </Link>
                ))}
                <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleSignOut}
                  className="block w-full px-4 py-2.5 text-left text-sm text-red-600 hover:bg-surface-light dark:text-red-400 dark:hover:bg-neutral-800"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </>
      );
    }

    return (
      <>
        {user?.is_suspended && <SuspensionBanner />}
        {avatarButton}
        <Sheet open={open} onClose={() => setOpen(false)} title="Account">
          <nav aria-label="Account" className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {accountLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="flex min-h-12 items-center px-2 py-3 text-base font-medium text-neutral-800 dark:text-neutral-200"
              >
                {link.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={handleSignOut}
              className="flex min-h-12 w-full items-center px-2 py-3 text-left text-base font-semibold text-red-600 dark:text-red-400"
            >
              Sign out
            </button>
          </nav>
        </Sheet>
      </>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        href="/login"
        className="rounded-full px-4 py-2 text-sm font-semibold text-primary-700 ring-1 ring-primary-500/30 hover:bg-primary-500/5 dark:text-primary-300"
      >
        Sign in
      </Link>
      <Link
        href="/signup"
        className="rounded-full bg-primary-500 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
      >
        Sign up
      </Link>
    </div>
  );
}
