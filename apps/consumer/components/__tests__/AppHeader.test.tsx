import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppHeader } from "../AppHeader";
import { useAuthStore } from "@/lib/store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
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

describe("AppHeader", () => {
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

  it("renders the brand and account entry", async () => {
    useAuthStore.setState({ accessToken: "tok-123", isAuthenticated: true });

    render(<AppHeader />);

    expect(screen.getByRole("link", { name: "SnakZap home" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Account menu" })).toBeDefined();
  });

  it("shows the suspension banner for a suspended account", async () => {
    useAuthStore.setState({
      accessToken: "tok-123",
      isAuthenticated: true,
      user: { id: "u1", phone: "9876543210", role: "CONSUMER", is_suspended: true },
    });

    render(<AppHeader />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText(/suspended/)).toBeDefined();
  });

  it("opens the account menu as a bottom sheet on mobile", async () => {
    useAuthStore.setState({ accessToken: "tok-123", isAuthenticated: true });

    render(<AppHeader />);

    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByRole("link", { name: "Your profile" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Order history" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Saved addresses" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
  });

  describe("desktop", () => {
    beforeEach(() => {
      setMatchMedia(true);
    });

    it("exposes the account menu entries", async () => {
      useAuthStore.setState({ accessToken: "tok-123", isAuthenticated: true });

      render(<AppHeader />);

      fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));

      expect(screen.getByRole("menuitem", { name: "Your profile" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Order history" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Saved addresses" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeDefined();
    });

    it("wires the account menu for assistive tech", async () => {
      useAuthStore.setState({ accessToken: "tok-123", isAuthenticated: true });

      render(<AppHeader />);

      const button = await screen.findByRole("button", { name: "Account menu" });
      expect(button.getAttribute("aria-haspopup")).toBe("menu");
      expect(button.getAttribute("aria-controls")).toBe("account-menu");
      expect(button.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(button);

      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("menu").getAttribute("id")).toBe("account-menu");
    });
  });
});
