import { create } from "zustand";
import { getDeviceFingerprint } from "./deviceFingerprint";
import {
  clearPersistedCart,
  fetchPersistedCart,
  releaseGift,
  savePersistedCart,
} from "./api";

// ============================================
// Auth Zustand store (EOS Layer 2.3 - JWT Strategy)
// Access token in memory only. Refresh via HttpOnly cookie.
// Device fingerprint bound to JWT for step-up auth.
// ============================================

export interface AuthUser {
  id: string;
  phone: string;
  role: string;
  is_suspended?: boolean;
}

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (phone: string, otp: string) => Promise<void>;
  sendOtp: (phone: string) => Promise<{ sent: boolean; expiresIn: number; demoOtp?: string }>;
  refreshAccessToken: () => Promise<boolean>;
  fetchMe: () => Promise<void>;
  logout: () => Promise<void>;
  getAuthHeaders: () => Record<string, string>;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

// Single-flight guard for the refresh endpoint. The refresh token is rotated
// (old jti blacklisted) on every /auth/refresh call, so two concurrent calls
// sharing the same cookie race: the first succeeds and the second gets
// REFRESH_TOKEN_REUSED (401), which AuthGate misreads as "logged out" and
// redirects to /login. React StrictMode double-invokes effects in dev, so a
// naive refresh call fires twice. Dedupe concurrent calls onto one promise.
let refreshInFlight: Promise<boolean> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  user: null,
  isAuthenticated: false,

  sendOtp: async (phone: string) => {
    // Sign-up is implicit: a new phone is auto-created as a CONSUMER by the
    // backend on the first send-otp, so there is no separate sign-up call.
    const res = await fetch(`${API_BASE}/api/v1/auth/consumer/send-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
      credentials: "include",
    });
    const body = await res.json();

    if (!body.success) {
      throw new Error(body.error?.message ?? "Failed to send OTP");
    }
    return {
      sent: body.data.sent,
      expiresIn: body.data.expiresInSeconds,
      demoOtp: body.data.demoOtp,
    };
  },

  login: async (phone: string, otp: string) => {
    const deviceFingerprint = getDeviceFingerprint();
    const res = await fetch(`${API_BASE}/api/v1/auth/consumer/verify-otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-fingerprint": deviceFingerprint,
      },
      body: JSON.stringify({ phone, otp, device_fingerprint: deviceFingerprint }),
      credentials: "include",
    });
    const body = await res.json();
    if (!body.success) {
      throw new Error(body.error?.message ?? "Login failed");
    }
    set({
      accessToken: body.data.access_token,
      user: body.data.user,
      isAuthenticated: true,
    });
  },

  refreshAccessToken: () => {
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const deviceFingerprint = getDeviceFingerprint();
          const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-device-fingerprint": deviceFingerprint,
            },
            body: JSON.stringify({ device_fingerprint: deviceFingerprint }),
            credentials: "include",
          });
          const body = await res.json();
          if (!body.success) {
            set({ accessToken: null, user: null, isAuthenticated: false });
            return false;
          }
          set({ accessToken: body.data.access_token, isAuthenticated: true });
          return true;
        } finally {
          refreshInFlight = null;
        }
      })();
    }
    return refreshInFlight;
  },

  fetchMe: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/me`, {
        method: "GET",
        credentials: "include",
      });
      const body = await res.json();
      if (!body.success) {
        return;
      }
      set({ user: body.data.user });
    } catch {
      // Non-fatal: keep the existing session state on network errors.
    }
  },

  logout: async () => {
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    set({ accessToken: null, user: null, isAuthenticated: false });
  },

  getAuthHeaders: (): Record<string, string> => {
    const token = get().accessToken;
    const headers: Record<string, string> = {
      "x-device-fingerprint": getDeviceFingerprint(),
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  },
}));

// ============================================
// Cart Zustand store (3-tap rule: open app -> pick item -> add to cart)
// Enforces single-restaurant ordering per PRD.
// ============================================

export interface CartCustomization {
  name: string;
  price_delta: number;
}

export interface CartItem {
  /** Stable per-line key: menuItemId for paid lines, `gift:<id>` for gifts,
   *  so a paid item and a claimed gift of the same menu item stay separate.
   *  Computed by the store on add/hydrate; callers may omit it. */
  lineKey?: string;
  menuItemId: string;
  name: string;
  basePrice: number;
  quantity: number;
  customizations: CartCustomization[];
  restaurantId: string;
  restaurantName?: string;
  /** Set on a redeemed ₹0 gift line; quantity is locked to 1. */
  giftId?: string;
  /** Claim token for a redeemed gift line; release-on-remove needs it. */
  giftToken?: string;
}

export function cartLineKey(item: { menuItemId: string; giftId?: string }): string {
  return item.giftId ? `gift:${item.giftId}` : item.menuItemId;
}

/** Opaque snapshot of the cart used by the cross-restaurant "Undo" action. */
export interface CartSnapshot {
  items: CartItem[];
  restaurantId: string | null;
  restaurantName: string | null;
}

export type AddItemResult =
  | { cleared: false }
  | {
      cleared: true;
      previousRestaurantName: string | null;
      clearedItemCount: number;
      snapshot: CartSnapshot;
    };

interface CartState {
  items: CartItem[];
  restaurantId: string | null;
  restaurantName: string | null;
  /** lineKey is derived from the item; callers may omit it. */
  addItem: (item: Omit<CartItem, "lineKey"> & { lineKey?: string }) => AddItemResult;
  /** Keyed by lineKey (menuItemId, or `gift:<id>` for gift lines). */
  removeItem: (lineKey: string) => void;
  /** Keyed by lineKey (menuItemId, or `gift:<id>` for gift lines). */
  updateQuantity: (lineKey: string, quantity: number) => void;
  clear: () => void;
  /** I-04: restore a cart snapshot (used by the toast "Undo" action). */
  restoreSnapshot: (snapshot: CartSnapshot) => void;
  itemCount: () => number;
  subtotal: () => number;
  /** O09: load the server-persisted cart (expired carts come back empty). */
  hydrateFromServer: (token: string) => Promise<void>;
}

/** Fire-and-forget server persistence of the current cart (O09). */
function persistCurrent() {
  const token = useAuthStore.getState().accessToken;
  if (!token) return;
  const { items, restaurantId, restaurantName } = useCartStore.getState();
  savePersistedCart(token, {
    restaurant_id: restaurantId,
    restaurant_name: restaurantName,
    items: items.map((i) => ({
      menu_item_id: i.menuItemId,
      quantity: i.quantity,
      name: i.name,
      base_price: i.basePrice,
      customizations: i.customizations,
      restaurant_id: i.restaurantId,
      gift_id: i.giftId,
      gift_token: i.giftToken,
    })),
  }).catch(() => {
    // Offline / server hiccup: local cart stays authoritative.
  });
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  restaurantId: null,
  restaurantName: null,

  addItem: (item) => {
    const current = get();

    // I-04: crossing into a new restaurant clears the single-restaurant cart.
    // We snapshot the old cart so the UI can offer an "Undo" toast.
    if (current.restaurantId && current.restaurantId !== item.restaurantId) {
      const snapshot: CartSnapshot = {
        items: current.items,
        restaurantId: current.restaurantId,
        restaurantName: current.restaurantName,
      };
      set({
        items: [{ ...item, lineKey: cartLineKey(item) }],
        restaurantId: item.restaurantId,
        restaurantName: item.restaurantName ?? current.restaurantName,
      });
      persistCurrent();
      return {
        cleared: true,
        previousRestaurantName: current.restaurantName,
        clearedItemCount: current.items.reduce((sum, i) => sum + i.quantity, 0),
        snapshot,
      };
    }

    const state = get();
    const key = cartLineKey(item);
    const existing = state.items.find((i) => i.lineKey === key);
    if (existing) {
      set({
        items: state.items.map((i) =>
          i.lineKey === key ? { ...i, quantity: i.quantity + item.quantity } : i,
        ),
        restaurantId: item.restaurantId,
        restaurantName: item.restaurantName ?? current.restaurantName,
      });
    } else {
      set({
        items: [...state.items, { ...item, lineKey: key }],
        restaurantId: item.restaurantId,
        restaurantName: item.restaurantName ?? current.restaurantName,
      });
    }
    persistCurrent();
    return { cleared: false };
  },

  removeItem: (lineKey) => {
    const current = get();
    const removed = current.items.find((i) => i.lineKey === lineKey);
    const next = current.items.filter((i) => i.lineKey !== lineKey);
    set({
      items: next,
      restaurantId: next.length > 0 ? current.restaurantId : null,
      restaurantName: next.length > 0 ? current.restaurantName : null,
    });
    persistCurrent();
    const token = useAuthStore.getState().accessToken;
    if (token && removed?.giftToken) {
      void releaseGift(token, removed.giftToken).catch(() => {
        // best-effort: the server sweep reclaims expired claims
      });
    }
  },

  updateQuantity: (lineKey, quantity) => {
    if (quantity <= 0) {
      get().removeItem(lineKey);
      return;
    }
    set({
      items: get().items.map((i) =>
        i.lineKey === lineKey ? { ...i, quantity } : i,
      ),
    });
    persistCurrent();
  },

  clear: () => {
    set({ items: [], restaurantId: null, restaurantName: null });
    const token = useAuthStore.getState().accessToken;
    if (token) {
      clearPersistedCart(token).catch(() => {});
    }
  },

  restoreSnapshot: (snapshot) => {
    set({
      items: snapshot.items,
      restaurantId: snapshot.restaurantId,
      restaurantName: snapshot.restaurantName,
    });
    persistCurrent();
  },

  itemCount: () => get().items.reduce((sum, i) => sum + i.quantity, 0),

  subtotal: () =>
    get().items.reduce(
      (sum, i) =>
        sum +
        (i.basePrice +
          i.customizations.reduce((s, c) => s + c.price_delta, 0)) *
          i.quantity,
      0,
    ),

  hydrateFromServer: async (token) => {
    try {
      const saved = await fetchPersistedCart(token);
      if (saved.expired || saved.items.length === 0) {
        set({ items: [], restaurantId: null, restaurantName: null });
        return;
      }
      set({
        items: saved.items.map((i) => ({
          lineKey: i.gift_id
            ? `gift:${i.gift_id}`
            : i.menu_item_id,
          menuItemId: i.menu_item_id,
          name: i.name ?? `Item ${i.menu_item_id.slice(0, 8)}`,
          basePrice: i.base_price ?? 0,
          quantity: i.quantity,
          customizations: i.customizations ?? [],
          restaurantId: i.restaurant_id ?? saved.restaurant_id ?? "",
          giftId: (i as { gift_id?: string | null }).gift_id ?? undefined,
          giftToken: (i as { gift_token?: string | null }).gift_token ?? undefined,
        })),
        restaurantId: saved.restaurant_id,
        restaurantName: saved.restaurant_name,
      });
    } catch {
      // Unauthenticated or unreachable: keep the empty local cart.
    }
  },
}));
