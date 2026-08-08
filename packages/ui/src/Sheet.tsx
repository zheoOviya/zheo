"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  className?: string;
}

export function Sheet({ open, onClose, children, title, className = "" }: SheetProps) {
  const [mounted, setMounted] = useState(false);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => setAnimating(true));
      document.body.style.overflow = "hidden";
    } else {
      setAnimating(false);
      const timer = setTimeout(() => {
        setMounted(false);
        document.body.style.overflow = "";
      }, 250);
      return () => clearTimeout(timer);
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const handleBackdropClick = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div
        className={[
          "absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-250",
          animating ? "opacity-100" : "opacity-0",
        ].join(" ")}
        onClick={handleBackdropClick}
      />
      <div
        className={[
          "relative w-full max-w-lg rounded-t-xl",
          "bg-white dark:bg-neutral-900",
          "shadow-elevation-5",
          "transition-transform duration-250 ease-out",
          animating ? "translate-y-0" : "translate-y-full",
          className,
        ].join(" ")}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-neutral-300 dark:bg-neutral-600" />
        </div>
        {title && (
          <div className="px-4 pb-2">
            <h2 className="text-lg font-bold text-neutral-900 dark:text-white">{title}</h2>
          </div>
        )}
        <div className="max-h-[70vh] overflow-y-auto px-4 pb-8">{children}</div>
        <div className="pb-safe" aria-hidden="true" />
      </div>
    </div>
  );
}
