"use client";

import { useEffect, useRef } from "react";

// ============================================
// Modal-dialog focus management (UI7-B, Repair C).
//
// Hand-rolled bottom-sheet dialogs need the same a11y guarantees the shared
// <Sheet> primitive already provides: initial focus inside the dialog, Tab /
// Shift+Tab focus containment, Escape-to-close, focus restore to the trigger,
// and body scroll lock while open. This hook applies that exact pattern to the
// Dine-In dialogs WITHOUT the shared Sheet's 250ms exit animation, whose
// delayed unmount would let a freshly-opened dialog overlap a closing one.
// ============================================

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

interface UseDialogFocusOptions {
  /** When true the focus/keydown management is active. */
  open: boolean;
  /** Invoked on Escape. Callers guard close-during-submit as needed. */
  onEscape: () => void;
  /** When true Escape is ignored (e.g. an in-flight submission). */
  escapeDisabled?: boolean;
}

export function useDialogFocus({
  open,
  onEscape,
  escapeDisabled = false,
}: UseDialogFocusOptions) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const escapeDisabledRef = useRef(escapeDisabled);
  escapeDisabledRef.current = escapeDisabled;

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    if (panel) {
      const focusables = getFocusableElements(panel);
      const initial = focusables[0] ?? panel;
      initial.focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!escapeDisabledRef.current) onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const container = panelRef.current;
      if (!container) return;
      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;

      if (e.shiftKey) {
        if (
          document.activeElement === first ||
          !container.contains(document.activeElement)
        ) {
          e.preventDefault();
          last.focus();
        }
      } else if (
        document.activeElement === last ||
        !container.contains(document.activeElement)
      ) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  return panelRef;
}
