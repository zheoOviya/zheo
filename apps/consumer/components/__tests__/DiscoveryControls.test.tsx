import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { DiscoveryControls } from "../DiscoveryControls";
import { formatINR } from "@/lib/pricing";
import type { MenuItem, SearchResult } from "@/lib/api";

const harness = vi.hoisted(() => ({
  push: vi.fn(),
  onSelect: null as null | ((result: SearchResult) => void),
  onResults: null as null | ((items: MenuItem[]) => void),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));

vi.mock("../SearchBar", () => ({
  SearchBar: ({ onSelect }: { onSelect: (result: SearchResult) => void }) => {
    harness.onSelect = onSelect;
    return null;
  },
}));

vi.mock("../DietaryFilter", () => ({
  DietaryFilter: ({ onResults }: { onResults: (items: MenuItem[]) => void }) => {
    harness.onResults = onResults;
    return null;
  },
}));

const RESTAURANT_RESULT: SearchResult = { type: "restaurant", id: "r-1", name: "Restaurant One" };
const DISH_RESULT: SearchResult = {
  type: "dish",
  id: "m-1",
  name: "Dish One",
  restaurant_id: "r-2",
};
const MALFORMED_DISH_RESULT = { type: "dish", id: "m-2", name: "Dish Two" } as unknown as SearchResult;

function menuItem(
  overrides: Partial<MenuItem> & { id: string; name: string; price: number },
): MenuItem {
  return {
    restaurant_id: "r-1",
    dietary_tags: {},
    customizations: [],
    is_available: true,
    spice_level: 3,
    image_url: null,
    ...overrides,
  };
}

const VALID_DIETARY_ITEM = menuItem({
  id: "m-10",
  name: "Paneer Tikka",
  price: 249,
  restaurant_id: "r-9",
});
const MALFORMED_DIETARY_ITEM = {
  ...menuItem({ id: "m-11", name: "Mystery Dish", price: 150 }),
  restaurant_id: undefined,
} as unknown as MenuItem;

function selectSearchResult(result: SearchResult) {
  act(() => {
    harness.onSelect?.(result);
  });
}

function emitDietary(items: MenuItem[]) {
  act(() => {
    harness.onResults?.(items);
  });
}

beforeEach(() => {
  harness.push.mockReset();
  harness.onSelect = null;
  harness.onResults = null;
});

describe("DiscoveryControls navigation truth", () => {
  it("routes a restaurant selection to /restaurants/{id}", () => {
    render(<DiscoveryControls />);
    selectSearchResult(RESTAURANT_RESULT);
    expect(harness.push).toHaveBeenCalledWith("/restaurants/r-1");
  });

  it("routes a dish selection with restaurant_id to that restaurant", () => {
    render(<DiscoveryControls />);
    selectSearchResult(DISH_RESULT);
    expect(harness.push).toHaveBeenCalledWith("/restaurants/r-2");
  });

  it("does not navigate for a malformed dish selection without restaurant_id", () => {
    render(<DiscoveryControls />);
    selectSearchResult(MALFORMED_DISH_RESULT);
    expect(harness.push).not.toHaveBeenCalled();
    expect(harness.push).not.toHaveBeenCalledWith("/");
  });

  it("renders a valid dietary item as a link to its restaurant", () => {
    render(<DiscoveryControls />);
    emitDietary([VALID_DIETARY_ITEM]);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/restaurants/r-9");
  });

  it("renders a malformed dietary item as non-interactive content without a home link", () => {
    render(<DiscoveryControls />);
    emitDietary([MALFORMED_DIETARY_ITEM]);
    expect(screen.getByText("Mystery Dish")).toBeInTheDocument();
    expect(screen.getByText(formatINR(150))).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/"]')).toBeNull();
  });

  it("clears previously rendered dietary results when a search result is selected", () => {
    render(<DiscoveryControls />);
    emitDietary([VALID_DIETARY_ITEM]);
    expect(screen.getByText("Paneer Tikka")).toBeInTheDocument();
    selectSearchResult(RESTAURANT_RESULT);
    expect(screen.queryByText("Paneer Tikka")).not.toBeInTheDocument();
    expect(screen.queryByText(formatINR(249))).not.toBeInTheDocument();
  });

  it("preserves name and formatted price on valid dietary results", () => {
    render(<DiscoveryControls />);
    emitDietary([VALID_DIETARY_ITEM]);
    expect(screen.getByText("Paneer Tikka")).toBeInTheDocument();
    expect(screen.getByText(formatINR(249))).toBeInTheDocument();
  });
});
