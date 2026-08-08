"use client";

import { useEffect, useState } from "react";

interface CountdownTimerProps {
  targetSeconds: number;
  onExpire?: () => void;
  className?: string;
}

export function CountdownTimer({ targetSeconds, onExpire, className = "" }: CountdownTimerProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      const seconds = Math.floor((now - start) / 1000);
      setElapsed(seconds);
      if (seconds >= targetSeconds) {
        clearInterval(interval);
        onExpire?.();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [targetSeconds, onExpire]);

  const remaining = Math.max(0, targetSeconds - elapsed);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const pct = Math.min(100, (elapsed / targetSeconds) * 100);

  const isGreen = pct < 30;
  const isAmber = pct >= 30 && pct < 70;
  const isRed = pct >= 70;

  return (
    <span
      className={[
        "font-mono tabular-nums text-sm font-bold",
        isGreen && "text-urgency-green",
        isAmber && "text-urgency-amber",
        isRed && "text-urgency-red",
        className,
      ].join(" ")}
    >
      {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
    </span>
  );
}
