import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SkipLink } from "../SkipLink";

// CONSUMER_SKIP_LINK-A3 — keyboard bypass control.
// Source/behaviour only; no pathname/auth/route logic.

afterEach(() => {
  cleanup();
});

describe("SkipLink", () => {
  it("renders the user-visible bypass copy", () => {
    render(<SkipLink />);
    expect(screen.getByText("Skip to main content")).toBeInTheDocument();
  });

  it("points at the #main-content target", () => {
    render(<SkipLink />);
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
  });

  it("uses the existing .skip-link utility class", () => {
    render(<SkipLink />);
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveClass("skip-link");
  });

  it("focuses an existing #main-content target with tabIndex -1 on click", () => {
    render(
      <>
        <SkipLink />
        <div id="main-content" tabIndex={-1} data-testid="target" />
      </>,
    );

    const target = screen.getByTestId("target");
    expect(target).toHaveAttribute("tabindex", "-1");

    fireEvent.click(screen.getByRole("link", { name: "Skip to main content" }));

    expect(document.activeElement).toBe(target);
  });

  it("does not throw when the target is absent", () => {
    render(<SkipLink />);

    expect(() =>
      fireEvent.click(screen.getByRole("link", { name: "Skip to main content" })),
    ).not.toThrow();
  });
});
