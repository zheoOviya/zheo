"use client";

import type { ReactNode } from "react";

export interface BottomNavItem {
  icon: ReactNode;
  label: string;
  href: string;
  badge?: number;
}

interface BottomNavProps {
  items: BottomNavItem[];
  activeHref?: string;
  onNavigate?: (href: string) => void;
  className?: string;
}

export function BottomNav({ items, activeHref, onNavigate, className = "" }: BottomNavProps) {
  return (
    <nav
      aria-label="Primary"
      className={[
        "fixed inset-x-0 bottom-0 z-50 pb-safe",
        "pointer-events-none px-4 pb-3",
        className,
      ].join(" ")}
    >
      <div className="pointer-events-auto mx-auto flex h-16 max-w-sm items-center justify-around gap-1 rounded-3xl border border-white/60 bg-white/85 px-2 shadow-elevation-3 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/75">
        {items.map((item) => {
          const isActive = activeHref
            ? activeHref === item.href || (item.href !== "/" && activeHref.startsWith(item.href))
            : false;

          const handleClick = (e: React.MouseEvent) => {
            e.preventDefault();
            onNavigate?.(item.href);
          };

          return (
            <a
              key={item.href}
              href={item.href}
              onClick={onNavigate ? handleClick : undefined}
              aria-current={isActive ? "page" : undefined}
              className={[
                "relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5",
                "rounded-2xl transition-colors duration-200",
                isActive
                  ? "text-primary-700 dark:text-primary-300"
                  : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400",
              ].join(" ")}
            >
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute inset-1 rounded-2xl bg-primary-500/12 ring-1 ring-primary-500/20 dark:bg-primary-400/15 dark:ring-primary-400/25"
                />
              )}
              <span className="relative inline-flex">
                {item.icon}
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="absolute -right-3 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-2xs font-bold leading-none text-white">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                )}
              </span>
              <span className="relative mt-0.5 text-2xs font-semibold leading-none">
                {item.label}
              </span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
