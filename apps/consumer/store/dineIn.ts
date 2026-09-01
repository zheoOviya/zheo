import { create } from "zustand";

// ============================================
// Dine-In session context store (frozen UI1-B3/B4).
//
// MEMORY-ONLY navigation context cache. Backend dining_sessions state is the
// sole authority; this store holds the frozen minimal fields the menu needs
// and nothing sensitive: no table token, no owner_user_id, no timestamps, no
// billing fields, no can_start_session.
//
// No persist middleware, no localStorage, no sessionStorage — cold reload
// intentionally fails back to re-scan (no fabricated session). In-app route
// navigation survives because this module is a singleton inside the SPA
// session (same pattern as useAuthStore / useCartStore in lib/store.ts).
// ============================================

export const DINE_IN_SESSION_STATUSES = [
  "OPEN",
  "ACTIVE",
  "BILL_REQUESTED",
  "PAYMENT_PENDING",
  "CLOSED",
] as const;

export type DineInSessionStatus = (typeof DINE_IN_SESSION_STATUSES)[number];

export interface DineInContext {
  sessionId: string;
  restaurant: { id: string; name: string };
  table: { id: string; label: string };
  sessionStatus: DineInSessionStatus;
}

interface DineInStoreState {
  context: DineInContext | null;
  setContext: (ctx: DineInContext) => void;
  clearContext: () => void;
}

export const useDineInStore = create<DineInStoreState>((set) => ({
  context: null,
  // Persist EXACTLY the frozen fields — never spread caller input, so a
  // smuggled extra key (e.g. a table token) cannot enter the store.
  setContext: (ctx) =>
    set({
      context: {
        sessionId: ctx.sessionId,
        restaurant: { id: ctx.restaurant.id, name: ctx.restaurant.name },
        table: { id: ctx.table.id, label: ctx.table.label },
        sessionStatus: ctx.sessionStatus,
      },
    }),
  clearContext: () => set({ context: null }),
}));
