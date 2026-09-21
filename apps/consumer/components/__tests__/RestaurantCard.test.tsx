import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RestaurantCard } from "../RestaurantCard";
import { fetchRestaurantMenu, type MenuItem, type Restaurant } from "@/lib/api";
import { useCartStore } from "@/lib/store";

vi.mock("@/lib/api", () => ({ fetchRestaurantMenu: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const RESTAURANT: Restaurant = {
  id: "r1",
  name: "Green Bowl",
  is_active: true,
  lat: null,
  lng: null,
  pickup_eta_min: 15,
  rating: 4.5,
  cuisines: ["Veg"],
  price_for_one: 200,
  cover_image: null,
};

const ITEMS: MenuItem[] = [
  {
    id: "m1",
    restaurant_id: "r1",
    name: "Paneer Wrap",
    price: 149,
    dietary_tags: {},
    customizations: [],
    is_available: true,
    spice_level: 2,
    image_url: null,
  },
  {
    id: "m2",
    restaurant_id: "r1",
    name: "Veg Bowl",
    price: 199,
    dietary_tags: { VEG: true },
    customizations: [],
    is_available: true,
    spice_level: 3,
    image_url: null,
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const menuMock = vi.mocked(fetchRestaurantMenu);

function openSheet() {
  fireEvent.click(screen.getByRole("button", { name: "Quick add" }));
}

beforeEach(() => {
  menuMock.mockReset();
  useCartStore.setState({ items: [], restaurantId: null, restaurantName: null });
});

describe("RestaurantCard quick-add truth states", () => {
  it("opens the Quick Add sheet and calls the helper with restaurant.id", async () => {
    menuMock.mockResolvedValue(ITEMS);

    render(<RestaurantCard restaurant={RESTAURANT} index={0} />);
    openSheet();

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(menuMock).toHaveBeenCalledWith("r1"));
  });

  it("renders menu items for a valid non-empty response", async () => {
    menuMock.mockResolvedValue(ITEMS);

    render(<RestaurantCard restaurant={RESTAURANT} index={0} />);
    openSheet();

    expect(await screen.findByText("Paneer Wrap")).toBeInTheDocument();
    expect(screen.getByText("Veg Bowl")).toBeInTheDocument();
  });

  it("shows 'No items available' for a valid empty response", async () => {
    menuMock.mockResolvedValue([]);

    render(<RestaurantCard restaurant={RESTAURANT} index={0} />);
    openSheet();

    expect(await screen.findByText("No items available")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load menu")).not.toBeInTheDocument();
  });

  it("shows an explicit failure state that is distinct from empty", async () => {
    menuMock.mockRejectedValue(new Error("Request failed"));

    render(<RestaurantCard restaurant={RESTAURANT} index={0} />);
    openSheet();

    expect(await screen.findByText("Couldn't load menu")).toBeInTheDocument();
    expect(screen.queryByText("No items available")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("retries manually and replaces the error with menu items", async () => {
    menuMock.mockRejectedValueOnce(new Error("Request failed"));
    menuMock.mockResolvedValueOnce(ITEMS);

    render(<RestaurantCard restaurant={RESTAURANT} index={0} />);
    openSheet();

    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);

    expect(await screen.findByText("Paneer Wrap")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load menu")).not.toBeInTheDocument();
    expect(menuMock).toHaveBeenCalledTimes(2);
  });

  it("hides the retry control while a retry is in flight (no duplicate click)", async () => {
    const retryDeferred = deferred<MenuItem[]>();
    menuMock.mockRejectedValueOnce(new Error("Request failed"));
    menuMock.mockReturnValueOnce(retryDeferred.promise);

    render(<RestaurantCard restaurant={RESTAURANT} index={0} />);
    openSheet();

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument(),
    );

    retryDeferred.resolve(ITEMS);
    expect(await screen.findByText("Paneer Wrap")).toBeInTheDocument();
  });
});
