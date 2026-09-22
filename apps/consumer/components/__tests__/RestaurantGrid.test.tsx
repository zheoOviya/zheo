import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RestaurantGrid } from "../RestaurantGrid";
import type { Restaurant } from "@/lib/api";

vi.mock("../RestaurantCard", () => ({
  RestaurantCard: ({ restaurant }: { restaurant: { id: string } }) => (
    <div data-testid="restaurant-card" data-id={restaurant.id} />
  ),
}));

function restaurant(id: string): Restaurant {
  return {
    id,
    name: `Restaurant ${id}`,
    is_active: true,
    lat: null,
    lng: null,
    pickup_eta_min: 20,
    rating: null,
    cuisines: [],
    price_for_one: null,
    cover_image: null,
  };
}

const EMPTY_PRIMARY = "No restaurants available right now";
const EMPTY_SECONDARY = "Check back soon.";

describe("RestaurantGrid empty-state claim truth", () => {
  it("renders the bounded primary copy on empty", () => {
    render(<RestaurantGrid restaurants={[]} />);
    expect(screen.getByText(EMPTY_PRIMARY)).toBeInTheDocument();
  });

  it("renders the exact bounded secondary copy on empty", () => {
    render(<RestaurantGrid restaurants={[]} />);
    expect(screen.getByText(EMPTY_SECONDARY)).toBeInTheDocument();
  });

  it("does not render the unsupported weekly cadence claim on empty", () => {
    render(<RestaurantGrid restaurants={[]} />);
    expect(screen.queryByText(/new places are joining SnakZap every week/)).not.toBeInTheDocument();
  });

  it("does not render any RestaurantCard on empty", () => {
    render(<RestaurantGrid restaurants={[]} />);
    expect(screen.queryAllByTestId("restaurant-card")).toHaveLength(0);
  });

  it("renders one RestaurantCard per restaurant on non-empty", () => {
    render(<RestaurantGrid restaurants={[restaurant("a"), restaurant("b")]} />);
    expect(screen.getAllByTestId("restaurant-card")).toHaveLength(2);
  });

  it("does not render either empty-state copy on non-empty", () => {
    render(<RestaurantGrid restaurants={[restaurant("a")]} />);
    expect(screen.queryByText(EMPTY_PRIMARY)).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY_SECONDARY)).not.toBeInTheDocument();
  });
});
