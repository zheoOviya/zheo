import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import AddressesPage from "./page";
import { useAuthStore } from "@/lib/store";

vi.mock("@/components/AuthGate", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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

describe("AddressesPage", () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: "tok-123",
      user: { id: "u1", phone: "9876543210", role: "CONSUMER" },
      isAuthenticated: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the global header and account menu", async () => {
    render(<AddressesPage />);

    expect(screen.getByText("Saved Addresses")).toBeDefined();
    expect(screen.getByRole("link", { name: "SnakZap home" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Account menu" })).toBeDefined();
  });

  it("shows the suspension banner for a suspended account", async () => {
    useAuthStore.setState({
      user: { id: "u1", phone: "9876543210", role: "CONSUMER", is_suspended: true },
    });

    render(<AddressesPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByText(/suspended/)).toBeDefined();
  });
});
