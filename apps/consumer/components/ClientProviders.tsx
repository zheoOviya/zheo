"use client";

import type { ReactNode } from "react";
import { HomeIcon, ClockIcon, ShoppingBagIcon, UserIcon } from "@heroicons/react/24/outline";
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

// Full-screen, focused flows without the global pickup-cart bottom nav. The
// dine-in menu is one of them: it hosts the sticky "Place order" CTA which
// must stay reachable above the viewport edge.
const FULL_SCREEN_PAGES = [
  "/login",
  "/signup",
  "/onboarding",
  "/dine-in/menu",
];

const navItems: BottomNavItem[] = [
  {
    icon: <HomeIcon className="w-5 h-5" />,
    label: "Home",
    href: "/",
  },
  {
    icon: <ClockIcon className="w-5 h-5" />,
    label: "Orders",
    href: "/orders",
  },
  {
    icon: <ShoppingBagIcon className="w-5 h-5" />,
    label: "Cart",
    href: "/checkout",
  },
  {
    icon: <UserIcon className="w-5 h-5" />,
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
