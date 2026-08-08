"use client";

import type { ReactNode } from "react";
import { useState, useEffect } from "react";

interface ActiveOrderBarProps {
  restaurantName: string;
  status: string;
  etaSeconds: number;
  orderId: string;
  onTap?: (orderId: string) => void;
  className?: string;
}

export function ActiveOrderBar({
  restaurantName,
  status,
  etaSeconds,
  orderId,
  onTap,
  className = "",
}: ActiveOrderBarProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <button
      onClick={() => onTap?.(orderId)}
      className={[
        "fixed bottom-0 left-0 right-0 z-40 px-4 py-3",
        "bg-primary/95 dark:bg-primary/90 backdrop-blur-md",
        "text-white shadow-elevation-3",
        "animate-slide-up",
        "flex items-center justify-between gap-3 w-full",
        className,
      ].join(" ")}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-white" />
        </span>
        <div className="text-left min-w-0">
          <p className="text-xs font-semibold truncate">{restaurantName}</p>
          <p className="text-2xs opacity-80">{status}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-sm font-mono font-bold tabular-nums">
          {Math.floor(etaSeconds / 60)}:
          {String(etaSeconds % 60).padStart(2, "0")}
        </span>
        <svg className="w-4 h-4 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </button>
  );
}
