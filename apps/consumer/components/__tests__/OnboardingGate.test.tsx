import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OnboardingGate } from "../OnboardingGate";

const replace = vi.fn();
let currentPathname = "/";
let onboardingDone = false;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => currentPathname,
}));

vi.mock("@/lib/onboarding", () => ({
  hasCompletedOnboarding: () => onboardingDone,
}));

describe("OnboardingGate", () => {
  beforeEach(() => {
    replace.mockClear();
    currentPathname = "/";
    onboardingDone = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders children without redirecting on /onboarding", () => {
    currentPathname = "/onboarding";
    render(
      <OnboardingGate>
        <p>intro</p>
      </OnboardingGate>,
    );
    expect(screen.getByText("intro")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("allows /signup for non-onboarded visitors", () => {
    currentPathname = "/signup";
    render(
      <OnboardingGate>
        <p>signup</p>
      </OnboardingGate>,
    );
    expect(screen.getByText("signup")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("allows /login for non-onboarded visitors", () => {
    currentPathname = "/login";
    render(
      <OnboardingGate>
        <p>login</p>
      </OnboardingGate>,
    );
    expect(screen.getByText("login")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects non-onboarded visitors from other routes to /onboarding", () => {
    currentPathname = "/";
    render(
      <OnboardingGate>
        <p>home</p>
      </OnboardingGate>,
    );
    expect(replace).toHaveBeenCalledWith("/onboarding");
  });

  it("does not redirect onboarded visitors from other routes", () => {
    onboardingDone = true;
    currentPathname = "/restaurants/1";
    render(
      <OnboardingGate>
        <p>menu</p>
      </OnboardingGate>,
    );
    expect(screen.getByText("menu")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
