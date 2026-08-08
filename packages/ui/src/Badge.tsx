"use client";

import type { ReactNode } from "react";

interface BadgeProps {
  children: ReactNode;
  variant?: "default" | "gold" | "silver" | "bronze" | "green" | "amber" | "red";
  size?: "sm" | "md";
  pulse?: boolean;
  className?: string;
  icon?: ReactNode;
}

const variantStyles: Record<string, string> = {
  default: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  gold: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  silver: "bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400",
  bronze: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  red: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

const sizeStyles: Record<string, string> = {
  sm: "px-1.5 py-0.5 text-2xs",
  md: "px-2.5 py-1 text-xs",
};

export function Badge({ children, variant = "default", size = "sm", pulse = false, className = "", icon }: BadgeProps) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full font-semibold",
        variantStyles[variant],
        sizeStyles[size],
        className,
      ].join(" ")}
    >
      {pulse && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-pulse-dot absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
        </span>
      )}
      {icon}
      {children}
    </span>
  );
}
