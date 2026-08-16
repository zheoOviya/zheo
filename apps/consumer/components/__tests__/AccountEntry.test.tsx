import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountEntry } from "../AccountEntry";
import { useAuthStore } from "@/lib/store";

const routerPush = vi.fn();
const routerRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    "aria-label"?: string;
  }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const DESKTOP_QUERY = "(min-width: 768px)";

function setMatchMedia(desktop: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: desktop && query === DESKTOP_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe("AccountEntry", () => {
  beforeEach(() => {
    setMatchMedia(false);
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
      refreshAccessToken: vi.fn().mockResolvedValue(false),
      logout: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows Sign in / Sign up when unauthenticated", async () => {
    render(<AccountEntry />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Sign in" })).toBeDefined();
    });
    expect(screen.getByRole("link", { name: "Sign up" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Your profile" })).toBeNull();
  });

  it("shows the account menu when authenticated", async () => {
    useAuthStore.setState({ accessToken: "tok-123", isAuthenticated: true });

    render(<AccountEntry />);

    const menuButton = await screen.findByRole("button", { name: "Account menu" });
    expect(menuButton).toBeDefined();
  });

  it("opens a bottom-sheet drawer for the account menu on mobile", async () => {
    useAuthStore.setState({ accessToken: "tok-123", isAuthenticated: true });

    render(<AccountEntry />);

    const button = await screen.findByRole("button", { name: "Account menu" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");

    fireEvent.click(button);

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByRole("link", { name: "Your profile" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Order history" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Saved addresses" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
  });

  it("shows a suspension banner for a suspended account", async () => {
    useAuthStore.setState({
      accessToken: "tok-123",
      isAuthenticated: true,
      user: { id: "u1", phone: "9876543210", role: "CONSUMER", is_suspended: true },
    });

    render(<AccountEntry />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });
    expect(screen.getByText(/suspended/)).toBeDefined();
  });

  it("does not show a suspension banner for an active account", async () => {
    useAuthStore.setState({
      accessToken: "tok-123",
      isAuthenticated: true,
      user: { id: "u1", phone: "9876543210", role: "CONSUMER", is_suspended: false },
    });

    render(<AccountEntry />);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("desktop", () => {
    beforeEach(() => {
      setMatchMedia(true);
    });

    it("exposes profile, order history, saved addresses, and sign-out entries", async () => {
      useAuthStore.setState({ accessToken: "tok-123", isAuthenticated: true });

      render(<AccountEntry />);

      fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));

      expect(screen.getByRole("menuitem", { name: "Your profile" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Order history" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Saved addresses" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeDefined();
    });

    it("signs out from the header account menu", async () => {
      const logout = vi.fn().mockResolvedValue(undefined);
      useAuthStore.setState({ accessToken: "tok-123", isAuthenticated: true, logout });

      render(<AccountEntry />);

      fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));

      fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

      await waitFor(() => {
        expect(logout).toHaveBeenCalled();
      });
      expect(routerPush).toHaveBeenCalledWith("/login");
    });
  });
});
