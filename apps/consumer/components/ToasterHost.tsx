"use client";

import { useEffect, useState } from "react";
import { Toaster, toast, useToasterStore } from "react-hot-toast";

// I-10 Toast system. One Toaster instance for the whole app:
// - top-center on mobile, bottom-right on desktop (>= 768px)
// - max 3 toasts visible at once (oldest are dismissed first)
// - toasts announce as role="alert" + aria-live="assertive" (WCAG AA)

const DESKTOP_QUERY = "(min-width: 768px)";
const MAX_VISIBLE_TOASTS = 3;

export function ToasterHost() {
  const [position, setPosition] = useState<"top-center" | "bottom-right">(
    "top-center",
  );
  const { toasts } = useToasterStore();

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const apply = () =>
      setPosition(mql.matches ? "bottom-right" : "top-center");
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);

  // react-hot-toast stores toasts newest-first; keep only the newest 3.
  useEffect(() => {
    const overflow = toasts.slice(MAX_VISIBLE_TOASTS);
    overflow.forEach((t) => toast.dismiss(t.id));
  }, [toasts]);

  return (
    <Toaster
      position={position}
      toastOptions={{
        ariaProps: { role: "alert", "aria-live": "assertive" },
        style: {
          borderRadius: "0.75rem",
          fontSize: "0.875rem",
          boxShadow: "0 8px 24px rgba(13, 148, 136, 0.18)",
        },
      }}
    />
  );
}
