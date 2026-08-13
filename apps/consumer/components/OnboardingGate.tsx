"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { hasCompletedOnboarding } from "@/lib/onboarding";

// First-run gate: users who have not completed onboarding are taken to the
// intro carousel. Children render immediately (SSR-safe) and the redirect
// happens client-side, so server-rendered pages (e.g. the home restaurant
// grid) are never blank.
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === "/onboarding") return;
    if (!hasCompletedOnboarding()) {
      router.replace("/onboarding");
    }
  }, [pathname, router]);

  return <>{children}</>;
}
