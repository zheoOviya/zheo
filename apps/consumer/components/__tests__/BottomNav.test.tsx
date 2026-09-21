import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BottomNav } from "@snakzap/ui";
import type { BottomNavItem } from "@snakzap/ui";

const HOME_ICON = (
  <svg data-testid="icon-home" viewBox="0 0 24 24">
    <path d="M2.25 12l8.954-8.955" />
  </svg>
);

const ORDERS_ICON = (
  <svg data-testid="icon-orders" viewBox="0 0 24 24">
    <path d="M12 6v6h4.5" />
  </svg>
);

const CART_ICON = (
  <svg data-testid="icon-cart" viewBox="0 0 24 24">
    <path d="M15.75 10.5V6" />
  </svg>
);

const PROFILE_ICON = (
  <svg data-testid="icon-profile" viewBox="0 0 24 24">
    <path d="M15.75 6a3.75 3.75 0 11-7.5 0" />
  </svg>
);

const DEFAULT_ITEMS: BottomNavItem[] = [
  { icon: HOME_ICON, label: "Home", href: "/" },
  { icon: ORDERS_ICON, label: "Orders", href: "/orders" },
  { icon: CART_ICON, label: "Cart", href: "/checkout" },
  { icon: PROFILE_ICON, label: "Profile", href: "/profile" },
];

describe("BottomNav", () => {
  it("renders all navigation items", () => {
    render(<BottomNav items={DEFAULT_ITEMS} />);
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Orders")).toBeInTheDocument();
    expect(screen.getByText("Cart")).toBeInTheDocument();
    expect(screen.getByText("Profile")).toBeInTheDocument();
  });

  it("renders links with correct hrefs", () => {
    render(<BottomNav items={DEFAULT_ITEMS} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(4);
    expect(links[0]).toHaveAttribute("href", "/");
    expect(links[1]).toHaveAttribute("href", "/orders");
    expect(links[2]).toHaveAttribute("href", "/checkout");
    expect(links[3]).toHaveAttribute("href", "/profile");
  });

  it("marks the active tab based on activeHref", () => {
    render(<BottomNav items={DEFAULT_ITEMS} activeHref="/orders" />);
    const links = screen.getAllByRole("link");
    expect(links[0]!.className).not.toContain("text-primary");
    expect(links[1]!.className).toContain("text-primary");
    expect(links[2]!.className).not.toContain("text-primary");
    expect(links[3]!.className).not.toContain("text-primary");
  });

  it("marks child routes as active", () => {
    render(<BottomNav items={DEFAULT_ITEMS} activeHref="/orders/123" />);
    const links = screen.getAllByRole("link");
    expect(links[1]!.className).toContain("text-primary");
  });

  it("shows badge on cart item", () => {
    const items: BottomNavItem[] = [
      { icon: CART_ICON, label: "Cart", href: "/checkout", badge: 3 },
    ];
    render(<BottomNav items={items} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows 99+ for badge counts over 99", () => {
    const items: BottomNavItem[] = [
      { icon: CART_ICON, label: "Cart", href: "/checkout", badge: 150 },
    ];
    render(<BottomNav items={items} />);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("hides badge when count is 0", () => {
    const items: BottomNavItem[] = [
      { icon: CART_ICON, label: "Cart", href: "/checkout", badge: 0 },
    ];
    render(<BottomNav items={items} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("hides badge when undefined", () => {
    const items: BottomNavItem[] = [
      { icon: CART_ICON, label: "Cart", href: "/checkout" },
    ];
    render(<BottomNav items={items} />);
    const links = screen.getAllByRole("link");
    expect(links[0]!.querySelector("[class*=rounded-full]")).not.toBeInTheDocument();
  });

  it("calls onNavigate when a tab is clicked", () => {
    const onNavigate = vi.fn();
    render(<BottomNav items={DEFAULT_ITEMS} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Orders"));
    expect(onNavigate).toHaveBeenCalledWith("/orders");
  });

  it("does not call onNavigate when not provided", () => {
    render(<BottomNav items={DEFAULT_ITEMS} />);
    fireEvent.click(screen.getByText("Orders"));
    // should not throw, default link behavior takes over
    expect(screen.getByText("Orders")).toBeInTheDocument();
  });

  it("CA-4 marks the active destination with aria-current=page", () => {
    render(<BottomNav items={DEFAULT_ITEMS} activeHref="/orders" />);
    const links = screen.getAllByRole("link");
    expect(links[1]).toHaveAttribute("aria-current", "page");
  });

  it("CA-4 marks a child route active with aria-current=page", () => {
    render(<BottomNav items={DEFAULT_ITEMS} activeHref="/orders/123" />);
    const links = screen.getAllByRole("link");
    expect(links[1]).toHaveAttribute("aria-current", "page");
  });

  it("CA-6 omits aria-current from inactive destinations", () => {
    render(<BottomNav items={DEFAULT_ITEMS} activeHref="/orders" />);
    const links = screen.getAllByRole("link");
    expect(links[0]).not.toHaveAttribute("aria-current");
    expect(links[2]).not.toHaveAttribute("aria-current");
    expect(links[3]).not.toHaveAttribute("aria-current");
  });

  it("CA-6 omits aria-current from every link when no activeHref is given", () => {
    render(<BottomNav items={DEFAULT_ITEMS} />);
    for (const link of screen.getAllByRole("link")) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("root exposes the additive 12px + safe-area padding contract", () => {
    const { container } = render(<BottomNav items={DEFAULT_ITEMS} />);
    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
    expect(nav!.className).toContain("fixed inset-x-0 bottom-0 z-50");
    expect(nav!.className).toContain("pointer-events-none px-4");
    expect(nav!.className).toContain("pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]");
    expect(nav!.className).not.toContain("pb-safe");
    expect(nav!.className).not.toContain("pb-3");
  });
});
