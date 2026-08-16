"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { hydrateSession, isAdmin } from "../lib/auth";

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    if (pathname === "/login") {
      setChecking(false);
      return;
    }

    if (isAdmin()) {
      setAllowed(true);
      setChecking(false);
      return;
    }

    // The access token is now httpOnly; hydrate the role from /api/v1/auth/me
    // (covers hard reloads where in-memory state is empty).
    hydrateSession()
      .then((role) => {
        if (cancelled) return;
        if (role === "ADMIN" || role === "SUPER_ADMIN") {
          setAllowed(true);
          setChecking(false);
        } else {
          router.replace("/login");
        }
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });

    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  if (pathname === "/login") return <>{children}</>;
  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-light dark:bg-surface-dark">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }
  if (!allowed) return null;
  return <>{children}</>;
}
