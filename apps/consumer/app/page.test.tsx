import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { render, fireEvent, screen, within } from "@testing-library/react";
import HomePage from "./page";
import { fetchRestaurants, type Restaurant } from "@/lib/api";

vi.mock("@/lib/api", () => ({ fetchRestaurants: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/RestaurantGrid", () => ({
  RestaurantGrid: ({ restaurants }: { restaurants: unknown[] }) => (
    <div data-testid="restaurant-grid" data-count={restaurants.length} />
  ),
}));

vi.mock("@/components/DiscoveryControls", () => ({ DiscoveryControls: () => null }));
vi.mock("@/components/PersonalizedFeed", () => ({ PersonalizedFeed: () => null }));
vi.mock("@/components/TrendingCarousel", () => ({ TrendingCarousel: () => null }));
vi.mock("@/components/AccountEntry", () => ({ AccountEntry: () => null }));
vi.mock("@/components/AppHeader", () => ({ BrandMark: () => null }));

const fetchRestaurantsMock = vi.mocked(fetchRestaurants);

function restaurant(overrides: Partial<Restaurant> & { id: string }): Restaurant {
  return {
    name: "Test Restaurant",
    is_active: true,
    lat: null,
    lng: null,
    pickup_eta_min: 20,
    rating: null,
    cuisines: [],
    price_for_one: null,
    cover_image: null,
    ...overrides,
  };
}

const ACTIVE_A = restaurant({ id: "a", name: "Alpha", is_active: true, pickup_eta_min: 10 });
const ACTIVE_B = restaurant({ id: "b", name: "Beta", is_active: true, pickup_eta_min: 20 });
const INACTIVE_C = restaurant({ id: "c", name: "Gamma", is_active: false, pickup_eta_min: 40 });

async function renderPage() {
  render(await HomePage());
}

beforeEach(() => {
  fetchRestaurantsMock.mockReset();
});

describe("HomePage restaurant fetch truth", () => {
  it("renders the actual restaurant count on non-empty success", async () => {
    fetchRestaurantsMock.mockResolvedValue([ACTIVE_A, ACTIVE_B, INACTIVE_C]);
    await renderPage();
    expect(screen.getByText("3 available")).toBeInTheDocument();
  });

  it("computes Open now from active entries on non-empty success", async () => {
    fetchRestaurantsMock.mockResolvedValue([ACTIVE_A, ACTIVE_B, INACTIVE_C]);
    await renderPage();
    const openNow = screen.getByText("Open now").parentElement as HTMLElement;
    expect(within(openNow).getByText("2")).toBeInTheDocument();
  });

  it("computes the rounded average pickup ETA on non-empty success", async () => {
    fetchRestaurantsMock.mockResolvedValue([ACTIVE_A, ACTIVE_B, INACTIVE_C]);
    await renderPage();
    expect(screen.getByText("~23 min")).toBeInTheDocument();
  });

  it("renders Mode = Pickup on non-empty success", async () => {
    fetchRestaurantsMock.mockResolvedValue([ACTIVE_A]);
    await renderPage();
    expect(screen.getByText("Pickup")).toBeInTheDocument();
  });

  it("renders 0 available on successful empty", async () => {
    fetchRestaurantsMock.mockResolvedValue([]);
    await renderPage();
    expect(screen.getByText("0 available")).toBeInTheDocument();
  });

  it("renders Open now = 0 on successful empty", async () => {
    fetchRestaurantsMock.mockResolvedValue([]);
    await renderPage();
    const openNow = screen.getByText("Open now").parentElement as HTMLElement;
    expect(within(openNow).getByText("0")).toBeInTheDocument();
  });

  it("does not render an Avg. pickup metric on successful empty", async () => {
    fetchRestaurantsMock.mockResolvedValue([]);
    await renderPage();
    expect(screen.queryByText("Avg. pickup")).not.toBeInTheDocument();
    expect(screen.queryByText("~20 min")).not.toBeInTheDocument();
  });

  it("uses the RestaurantGrid path and not the error UI on successful empty", async () => {
    fetchRestaurantsMock.mockResolvedValue([]);
    await renderPage();
    expect(screen.getByTestId("restaurant-grid")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the exact bounded error copy on fetch failure", async () => {
    fetchRestaurantsMock.mockRejectedValue(new Error("boom"));
    await renderPage();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load restaurants. Please try again later.");
  });

  it("does not render the raw helper/API error message on fetch failure", async () => {
    fetchRestaurantsMock.mockRejectedValue(
      new Error("ECONNREFUSED 10.0.0.1:3001 - upstream exploded"),
    );
    await renderPage();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/upstream exploded/)).not.toBeInTheDocument();
  });

  it("does not render fabricated metrics on fetch failure", async () => {
    fetchRestaurantsMock.mockRejectedValue(new Error("boom"));
    await renderPage();
    expect(screen.queryByText("0 available")).not.toBeInTheDocument();
    expect(screen.queryByText("Open now")).not.toBeInTheDocument();
    expect(screen.queryByText("~20 min")).not.toBeInTheDocument();
    expect(screen.queryByText(/~\d+ min/)).not.toBeInTheDocument();
  });

  it("still renders the truthful Mode = Pickup on fetch failure", async () => {
    fetchRestaurantsMock.mockRejectedValue(new Error("boom"));
    await renderPage();
    expect(screen.getByText("Pickup")).toBeInTheDocument();
  });
});

// CONSUMER_SKIP_LINK-A3 — home owns its inline header, so it repeats the
// skip-link + post-header target contract locally.
describe("HomePage skip-link bypass", () => {
  it("renders a skip link before the home header and target", async () => {
    fetchRestaurantsMock.mockResolvedValue([ACTIVE_A]);
    const { container } = render(await HomePage());
    const ordered = Array.from(
      container.querySelectorAll("a.skip-link, header, #main-content"),
    ).map((node) => (node as HTMLElement).id || node.tagName.toLowerCase());
    expect(ordered).toEqual(["a", "header", "main-content"]);
  });

  it("renders exactly one #main-content target with tabIndex -1", async () => {
    fetchRestaurantsMock.mockResolvedValue([ACTIVE_A]);
    const { container } = render(await HomePage());
    const targets = container.querySelectorAll("#main-content");
    expect(targets).toHaveLength(1);
    expect((targets[0] as HTMLElement).getAttribute("tabindex")).toBe("-1");
  });

  it("does not create duplicate target ids", async () => {
    fetchRestaurantsMock.mockResolvedValue([ACTIVE_A]);
    const { container } = render(await HomePage());
    expect(container.querySelectorAll("#main-content")).toHaveLength(1);
  });

  it("moves focus to the target when the skip link is activated", async () => {
    fetchRestaurantsMock.mockResolvedValue([ACTIVE_A]);
    const { container } = render(await HomePage());
    const target = container.querySelector("#main-content") as HTMLElement;
    fireEvent.click(screen.getByRole("link", { name: "Skip to main content" }));
    expect(document.activeElement).toBe(target);
  });
});
