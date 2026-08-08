import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Container } from "@snakzap/ui";

describe("Container", () => {
  it("renders children", () => {
    render(<Container>Hello</Container>);
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  it("applies the default max-width and gutter classes", () => {
    render(<Container>content</Container>);
    const el = screen.getByText("content");
    expect(el.className).toContain("max-w-5xl");
    expect(el.className).toContain("mx-auto");
    expect(el.className).toContain("w-full");
    expect(el.className).toContain("px-4");
    expect(el.className).toContain("sm:px-6");
  });

  it.each([
    ["2xl", "max-w-2xl"],
    ["3xl", "max-w-3xl"],
    ["7xl", "max-w-7xl"],
    ["full", "max-w-none"],
  ] as const)("honors maxWidth=%s", (maxWidth, expected) => {
    render(<Container maxWidth={maxWidth}>content</Container>);
    const el = screen.getByText("content");
    expect(el.className).toContain(expected);
    expect(el.className).not.toContain("max-w-5xl");
  });

  it("merges a caller className without dropping the global gutter", () => {
    render(<Container className="py-6">content</Container>);
    const el = screen.getByText("content");
    expect(el.className).toContain("py-6");
    expect(el.className).toContain("px-4");
  });
});
