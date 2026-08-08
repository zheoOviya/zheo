"use client";

import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  hoverable?: boolean;
  glass?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const paddingStyles: Record<string, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export function Card({
  children,
  hoverable = false,
  glass = false,
  padding = "md",
  className = "",
  ...props
}: CardProps) {
  return (
    <div
      className={[
        "rounded-xl border border-neutral-200/60 dark:border-neutral-800/60",
        glass
          ? "bg-white/70 dark:bg-neutral-900/70 backdrop-blur-xl"
          : "bg-white dark:bg-neutral-900",
        "shadow-elevation-1",
        hoverable &&
          "transition-all duration-200 hover:-translate-y-1 hover:shadow-elevation-3 cursor-pointer",
        paddingStyles[padding],
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}

function CardHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={["flex items-center justify-between pb-3 border-b border-neutral-100 dark:border-neutral-800", className].join(" ")}>
      {children}
    </div>
  );
}

function CardContent({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

function CardFooter({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={["flex items-center gap-2 pt-3 border-t border-neutral-100 dark:border-neutral-800", className].join(" ")}>
      {children}
    </div>
  );
}

Card.Header = CardHeader;
Card.Content = CardContent;
Card.Footer = CardFooter;
