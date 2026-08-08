import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import VendorLoginPage from "../page";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.replace.mockReset();
});

describe("Vendor /login page (informational)", () => {
  it("renders an informative message and a manual dashboard link", () => {
    render(<VendorLoginPage />);
    expect(screen.getByText("SnakZap Kitchen")).toBeDefined();
    expect(screen.getByText(/has no sign-in page/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Go to Dashboard" })).toBeDefined();
  });

  it("does not redirect before the delay elapses", () => {
    vi.useFakeTimers();
    render(<VendorLoginPage />);
    expect(mocks.replace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("auto-redirects to the dashboard after 2.5s", () => {
    vi.useFakeTimers();
    render(<VendorLoginPage />);
    vi.advanceTimersByTime(2500);
    expect(mocks.replace).toHaveBeenCalledWith("/");
  });
});
