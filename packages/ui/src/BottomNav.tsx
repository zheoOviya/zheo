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
      className={[
        "fixed bottom-0 left-0 right-0 z-50 min-h-16 pb-safe",
        "bg-white/80 dark:bg-neutral-950/80 backdrop-blur-xl",
        "border-t border-neutral-200/60 dark:border-neutral-800/60",
        className,
      ].join(" ")}
    >
      <div className="mx-auto flex h-16 max-w-lg items-center justify-around px-2">
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
              className={[
                "relative flex min-h-11 flex-col items-center justify-center gap-0.5 min-w-0 flex-1",
                "transition-colors duration-200",
                isActive
                  ? "text-primary"
                  : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400",
              ].join(" ")}
            >
              <span className="relative inline-flex">
                {item.icon}
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="absolute -top-1.5 -right-3 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-2xs font-bold leading-none">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                )}
              </span>
              <span className="text-2xs font-medium leading-none mt-0.5">{item.label}</span>
              {isActive && (
                <span className="absolute bottom-0 left-1/4 right-1/4 h-0.5 rounded-full bg-primary" />
              )}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
