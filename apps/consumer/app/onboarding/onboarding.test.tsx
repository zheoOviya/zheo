import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OnboardingPage from "./page";

const { push, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

const FLAG = "snakzap_onboarded";

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  localStorage.clear();
});

function renderOnboarding() {
  const view = render(<OnboardingPage />);
  return {
    ...view,
    track: view.container.querySelector('[class*="overflow-hidden"]'),
  };
}

describe("Onboarding carousel (I-01)", () => {
  it("renders the first slide with Skip, Next and carousel semantics", () => {
    renderOnboarding();
    expect(screen.getByText("Order Ahead")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Next slide" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Previous slide" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("region", { name: "Welcome to SnakZap" }),
    ).toHaveAttribute("aria-roledescription", "carousel");
  });

  it("navigates slides via Next, Prev and dot controls", () => {
    renderOnboarding();
    const dots = screen.getAllByRole("tab");
    expect(dots).toHaveLength(3);
    expect(dots[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(dots[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Real-Time Alerts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(dots[2]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("No Delivery Fees")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    expect(dots[1]).toHaveAttribute("aria-selected", "true");
  });

  it("supports swipe navigation", () => {
    const { track } = renderOnboarding();
    const dots = screen.getAllByRole("tab");
    fireEvent.touchStart(track!, { touches: [{ clientX: 300 }] });
    fireEvent.touchEnd(track!, { changedTouches: [{ clientX: 80 }] });
    expect(dots[1]).toHaveAttribute("aria-selected", "true");
  });

  it("shows Get Started only on the final slide", () => {
    renderOnboarding();
    expect(
      screen.queryByRole("button", { name: "Get Started" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(
      screen.queryByRole("button", { name: "Get Started" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(
      screen.getByRole("button", { name: "Get Started" }),
    ).toBeInTheDocument();
  });

  it("Skip stores the flag and sends the user home", () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(localStorage.getItem(FLAG)).toBe("1");
    expect(push).toHaveBeenCalledWith("/");
  });

  it("Get Started stores the flag and sends the user home", () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));
    expect(localStorage.getItem(FLAG)).toBe("1");
    expect(push).toHaveBeenCalledWith("/");
  });

  it("redirects returning users straight to the home page", async () => {
    localStorage.setItem(FLAG, "1");
    renderOnboarding();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("applies reduced-motion safe transition classes", () => {
    const { container } = renderOnboarding();
    expect(
      container.querySelector('[class*="motion-reduce:transition-none"]'),
    ).toBeInTheDocument();
  });
});
