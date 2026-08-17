"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { hasCompletedOnboarding } from "@/lib/onboarding";

// First-run gate: users who have not completed onboarding are taken to the
// intro carousel. Children render immediately (SSR-safe) and the redirect
// happens client-side, so server-rendered pages (e.g. the home restaurant
// grid) are never blank. Auth routes are allowlisted so new visitors can
// reach signup/login directly without being bounced back to onboarding.
const ALLOWLISTED_PATHS = ["/onboarding", "/signup", "/login"];

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (ALLOWLISTED_PATHS.includes(pathname)) return;
    if (!hasCompletedOnboarding()) {
      router.replace("/onboarding");
    }
  }, [pathname, router]);

  return <>{children}</>;
}
