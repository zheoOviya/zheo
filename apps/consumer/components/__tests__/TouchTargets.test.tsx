import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button, BottomNav } from "@snakzap/ui";

describe("touch target enforcement", () => {
  it("Button md enforces min-h-[44px]", () => {
    render(<Button size="md">Add</Button>);
    const btn = screen.getByRole("button", { name: "Add" });
    expect(btn.className).toContain("min-h-[44px]");
  });

  it("Button lg enforces min-h-[44px]", () => {
    render(<Button size="lg">Order</Button>);
    const btn = screen.getByRole("button", { name: "Order" });
    expect(btn.className).toContain("min-h-[44px]");
  });

  it("BottomNav links have a 44px minimum height", () => {
    const item = { icon: <span aria-hidden="true">@</span>, label: "Home", href: "/" };
    render(<BottomNav items={[item]} activeHref="/" />);
    const link = screen.getByRole("link", { name: /Home/ });
    expect(link.className).toContain("min-h-11");
  });
});
