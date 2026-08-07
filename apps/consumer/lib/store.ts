import { create } from "zustand";
import { getDeviceFingerprint } from "./deviceFingerprint";
import {
  clearPersistedCart,
  fetchPersistedCart,
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
}

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (phone: string, otp: string) => Promise<void>;
  sendOtp: (phone: string) => Promise<{ sent: boolean; expiresIn: number }>;
  refreshAccessToken: () => Promise<boolean>;
  logout: () => Promise<void>;
  getAuthHeaders: () => Record<string, string>;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  user: null,
  isAuthenticated: false,

  sendOtp: async (phone: string) => {
    const res = await fetch(`${API_BASE}/api/v1/auth/send-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
      credentials: "include",
    });
    const body = await res.json();
    if (!body.success) {
      throw new Error(body.error?.message ?? "Failed to send OTP");
    }
    return { sent: body.data.sent, expiresIn: body.data.expiresInSeconds };
  },

  login: async (phone: string, otp: string) => {
    const deviceFingerprint = getDeviceFingerprint();
    const res = await fetch(`${API_BASE}/api/v1/auth/verify-otp`, {
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

  refreshAccessToken: async () => {
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
    set({ accessToken: body.data.access_token });
    return true;
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
  menuItemId: string;
  name: string;
  basePrice: number;
  quantity: number;
  customizations: CartCustomization[];
  restaurantId: string;
}

interface CartState {
  items: CartItem[];
  restaurantId: string | null;
  restaurantName: string | null;
  addItem: (item: CartItem) => void;
  removeItem: (menuItemId: string) => void;
  updateQuantity: (menuItemId: string, quantity: number) => void;
  clear: () => void;
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
    if (current.restaurantId && current.restaurantId !== item.restaurantId) {
      set({ items: [], restaurantId: null, restaurantName: null });
    }

    const existing = current.items.find((i) => i.menuItemId === item.menuItemId);
    if (existing) {
      set({
        items: current.items.map((i) =>
          i.menuItemId === item.menuItemId
            ? { ...i, quantity: i.quantity + item.quantity }
            : i,
        ),
        restaurantId: item.restaurantId,
      });
    } else {
      set({
        items: [...current.items, item],
        restaurantId: item.restaurantId,
      });
    }
    persistCurrent();
  },

  removeItem: (menuItemId) => {
    const next = get().items.filter((i) => i.menuItemId !== menuItemId);
    set({
      items: next,
      restaurantId: next.length > 0 ? get().restaurantId : null,
      restaurantName: next.length > 0 ? get().restaurantName : null,
    });
    persistCurrent();
  },

  updateQuantity: (menuItemId, quantity) => {
    if (quantity <= 0) {
      get().removeItem(menuItemId);
      return;
    }
    set({
      items: get().items.map((i) =>
        i.menuItemId === menuItemId ? { ...i, quantity } : i,
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
          menuItemId: i.menu_item_id,
          name: i.name ?? `Item ${i.menu_item_id.slice(0, 8)}`,
          basePrice: i.base_price ?? 0,
          quantity: i.quantity,
          customizations: i.customizations ?? [],
          restaurantId: i.restaurant_id ?? saved.restaurant_id ?? "",
        })),
        restaurantId: saved.restaurant_id,
        restaurantName: saved.restaurant_name,
      });
    } catch {
      // Unauthenticated or unreachable: keep the empty local cart.
    }
  },
}));
