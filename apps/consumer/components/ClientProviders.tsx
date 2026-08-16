"use client";

import type { ReactNode } from "react";
import { LazyMotion, domAnimation } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { BottomNav } from "@snakzap/ui";
import type { BottomNavItem } from "@snakzap/ui";
import { useCartStore } from "@/lib/store";
import { ThemeProvider } from "@/components/ThemeProvider";
import { I18nProvider } from "@/lib/i18n";
import { PwaProvider } from "@/components/PwaProvider";
import { FeatureFlagProvider } from "@/components/FeatureFlagProvider";
import { OnboardingGate } from "@/components/OnboardingGate";

const FULL_SCREEN_PAGES = ["/login", "/signup", "/onboarding"];

const navItems: BottomNavItem[] = [
  {
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"
        />
      </svg>
    ),
    label: "Home",
    href: "/",
  },
  {
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
    label: "Orders",
    href: "/orders",
  },
  {
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007zM8.625 10.5a.375.375 0 11-.75 0 .375.375 0 01.75 0zm7.5 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
        />
      </svg>
    ),
    label: "Cart",
    href: "/checkout",
  },
  {
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
        />
      </svg>
    ),
    label: "Profile",
    href: "/profile",
  },
];

export function ClientProviders({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const itemCount = useCartStore((s) => s.itemCount());
  const itemsWithBadge = navItems.map((item) =>
    item.href === "/checkout" ? { ...item, badge: itemCount } : item,
  );
  const isFullScreen = FULL_SCREEN_PAGES.includes(pathname);

  return (
    <ThemeProvider>
      <I18nProvider>
        <FeatureFlagProvider>
          <PwaProvider>
            <LazyMotion features={domAnimation} strict>
              <div className="min-h-dvh bg-surface-light dark:bg-surface-dark text-neutral-800 dark:text-neutral-200 font-sans antialiased">
                <div className={isFullScreen ? "" : "pb-20"}>
                  <OnboardingGate>{children}</OnboardingGate>
                </div>
                {!isFullScreen && (
                  <BottomNav
                    items={itemsWithBadge}
                    activeHref={pathname}
                    onNavigate={(href) => router.push(href)}
                  />
                )}
              </div>
            </LazyMotion>
          </PwaProvider>
        </FeatureFlagProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
