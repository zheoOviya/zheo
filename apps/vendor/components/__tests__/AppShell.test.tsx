import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "../AppShell";

type SessionUser = { id: string; phone: string; role: string; is_suspended?: boolean };

type VendorRestaurant = {
  id: string;
  name: string;
  is_active: boolean;
  commission_rate: number;
  chain_id: string | null;
};

const mocks = vi.hoisted(() => ({
  pathname: "/",
  isAuthenticated: vi.fn(() => false),
  getSessionUser: vi.fn<() => SessionUser | null>(() => null),
  hydrateSession: vi.fn(() => Promise.resolve<SessionUser | null>(null)),
  logout: vi.fn(() => Promise.resolve()),
  restaurants: [] as VendorRestaurant[],
  activeRestaurantId: null as string | null,
  load: vi.fn(() => Promise.resolve()),
  setActiveRestaurantId: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: mocks.isAuthenticated,
  getSessionUser: mocks.getSessionUser,
  hydrateSession: mocks.hydrateSession,
  logout: mocks.logout,
}));

vi.mock("@/lib/store", () => ({
  useVendorStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      restaurants: mocks.restaurants,
      activeRestaurantId: mocks.activeRestaurantId,
      status: "ready",
      error: null,
      load: mocks.load,
      setActiveRestaurantId: mocks.setActiveRestaurantId,
      reset: mocks.reset,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock("framer-motion", () => ({
  LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  domMax: {},
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pathname = "/";
  mocks.restaurants = [];
  mocks.activeRestaurantId = null;
});

describe("Vendor AppShell entry points", () => {
  it("shows Sign in / Apply links when unauthenticated", async () => {
    mocks.isAuthenticated.mockReturnValue(false);

    render(
      <AppShell>
        <p>dashboard</p>
      </AppShell>,
    );

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Sign in" })).toBeDefined();
    });
    expect(screen.getByRole("link", { name: "Apply to onboard your restaurant" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("renders the merchant shell when authenticated", async () => {
    mocks.isAuthenticated.mockReturnValue(true);
    mocks.getSessionUser.mockReturnValue({
      id: "u1",
      phone: "+919876543210",
      role: "VENDOR_OWNER",
    });

    render(
      <AppShell>
        <p>dashboard</p>
      </AppShell>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
    });
    expect(screen.getByText("Overview")).toBeDefined();
    expect(screen.getByText("Dine-In")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("renders standalone auth pages without the shell", async () => {
    mocks.pathname = "/login";
    mocks.isAuthenticated.mockReturnValue(false);

    render(
      <AppShell>
        <p>login child</p>
      </AppShell>,
    );

    expect(screen.getByText("login child")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("shows a suspension banner for a suspended merchant", async () => {
    mocks.isAuthenticated.mockReturnValue(true);
    mocks.getSessionUser.mockReturnValue({
      id: "u1",
      phone: "+919876543210",
      role: "VENDOR_OWNER",
      is_suspended: true,
    });

    render(
      <AppShell>
        <p>dashboard</p>
      </AppShell>,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });
    expect(screen.getByText(/suspended/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
  });

  it("does not show a suspension banner for an active merchant", async () => {
    mocks.isAuthenticated.mockReturnValue(true);
    mocks.getSessionUser.mockReturnValue({
      id: "u1",
      phone: "+919876543210",
      role: "VENDOR_OWNER",
      is_suspended: false,
    });

    render(
      <AppShell>
        <p>dashboard</p>
      </AppShell>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a restaurant selector when the vendor operates multiple restaurants", async () => {
    mocks.isAuthenticated.mockReturnValue(true);
    mocks.getSessionUser.mockReturnValue({
      id: "u1",
      phone: "+919876543210",
      role: "VENDOR_OWNER",
    });
    mocks.restaurants = [
      { id: "r1", name: "Biryani House", is_active: true, commission_rate: 0.08, chain_id: null },
      { id: "r2", name: "Green Bowl", is_active: true, commission_rate: 0.08, chain_id: null },
    ];
    mocks.activeRestaurantId = "r1";

    render(
      <AppShell>
        <p>dashboard</p>
      </AppShell>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
    });
    const select = screen.getByLabelText("Switch restaurant") as HTMLSelectElement;
    expect(select.value).toBe("r1");
    expect(screen.getByRole("option", { name: "Green Bowl" })).toBeDefined();
  });
});
