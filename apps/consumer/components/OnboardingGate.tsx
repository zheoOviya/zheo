"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { hasCompletedOnboarding } from "@/lib/onboarding";

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (pathname === "/onboarding") {
      setChecked(true);
      return;
    }
    if (!hasCompletedOnboarding()) {
      router.replace("/onboarding");
    } else {
      setChecked(true);
    }
  }, [pathname, router]);

  if (!checked) return null;

  return <>{children}</>;
}
