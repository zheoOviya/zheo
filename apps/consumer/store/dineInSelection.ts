import { create } from "zustand";

// ============================================
// Dine-In selection store (frozen UI3-A / UI3-B).
//
// MEMORY-ONLY, session-scoped client selection. NOT a checkout cart: nothing
// here is sent to the backend and no order is placed by this store. The
// backend owns all authoritative pricing at placeOrder time; the client keeps
// only display metadata.
//
// Line shape is the frozen minimum:
//   { menuItemId, name, displayPrice, quantity }
// No table token, no customizations, no GST, no authoritative total, no
// timestamps, no gift fields.
//
// No persist middleware, no localStorage, no sessionStorage — cold reload
// resets selection exactly like the Dine-In context model.
//
// Isolation: this store never touches useCartStore (pickup) and issues ZERO
// network requests. Wiring with the Dine-In context (useDineInStore) lives in
// the menu layer, not inside these stores.
// ============================================

export const DINE_IN_MAX_QUANTITY = 50;

export interface DineInSelectionLine {
  menuItemId: string;
  name: string;
  displayPrice: number;
  quantity: number;
}

/** Fields accepted on Add — explicit pick, never a MenuItem spread. */
export interface DineInSelectionInput {
  menuItemId: string;
  name: string;
  displayPrice: number;
}

interface DineInSelectionState {
  sessionId: string | null;
  lines: DineInSelectionLine[];
  /** Same session keeps lines; a different session clears them and adopts it. */
  ensureScope: (sessionId: string) => void;
  /** First Add creates one line at qty 1; repeated Add increments the same line. */
  add: (item: DineInSelectionInput) => void;
  remove: (menuItemId: string) => void;
  /** qty <= 0 removes the line; values are clamped to [1, 50]. */
  setQuantity: (menuItemId: string, quantity: number) => void;
  clear: () => void;
  itemCount: () => number;
  displayTotal: () => number;
}

export const useDineInSelectionStore = create<DineInSelectionState>((set, get) => ({
  sessionId: null,
  lines: [],

  ensureScope: (sessionId) => {
    if (get().sessionId === sessionId) return;
    set({ sessionId, lines: [] });
  },

  add: (item) => {
    const { lines } = get();
    const existing = lines.find((l) => l.menuItemId === item.menuItemId);
    // Explicit pick of allowed fields only — a caller smuggling extra keys
    // (token, customizations, ...) cannot persist them into the store.
    if (existing) {
      if (existing.quantity >= DINE_IN_MAX_QUANTITY) return;
      set({
        lines: lines.map((l) =>
          l.menuItemId === item.menuItemId
            ? { ...l, quantity: l.quantity + 1 }
            : l,
        ),
      });
      return;
    }
    set({
      lines: [
        ...lines,
        {
          menuItemId: item.menuItemId,
          name: item.name,
          displayPrice: item.displayPrice,
          quantity: 1,
        },
      ],
    });
  },

  remove: (menuItemId) => {
    set({ lines: get().lines.filter((l) => l.menuItemId !== menuItemId) });
  },

  setQuantity: (menuItemId, quantity) => {
    if (quantity <= 0) {
      get().remove(menuItemId);
      return;
    }
    const clamped = Math.min(quantity, DINE_IN_MAX_QUANTITY);
    set({
      lines: get().lines.map((l) =>
        l.menuItemId === menuItemId ? { ...l, quantity: clamped } : l,
      ),
    });
  },

  clear: () => set({ sessionId: null, lines: [] }),

  itemCount: () => get().lines.reduce((sum, l) => sum + l.quantity, 0),

  displayTotal: () =>
    get().lines.reduce((sum, l) => sum + l.displayPrice * l.quantity, 0),
}));
