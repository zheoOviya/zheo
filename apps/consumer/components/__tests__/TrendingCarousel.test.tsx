import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TrendingCarousel } from "../TrendingCarousel";
import { fetchTrending, type TrendingDish, type TrendingResponse } from "@/lib/api";

vi.mock("@/lib/api", () => ({ fetchTrending: vi.fn() }));

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

function dish(id: string, name: string): TrendingDish {
  return {
    menu_item_id: id,
    name,
    price: 249,
    restaurant_id: `r-${id}`,
    restaurant_name: `Restaurant ${id}`,
    orders_count: 12,
    quantity_sold: 30,
  };
}

function response(trending: TrendingDish[]): TrendingResponse {
  return {
    window_minutes: 60,
    radius_km: 5,
    location: { lat: 19.076, lng: 72.8777 },
    generated_at: "2026-09-22T00:00:00.000Z",
    trending,
  };
}

const NONEMPTY = response([dish("m1", "Paneer Tikka")]);
const EMPTY = response([]);

const EMPTY_COPY = "No trending dishes in the last hour yet";
const ERROR_COPY = "Couldn't load trending dishes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function skeletonCount(container: HTMLElement) {
  return container.querySelectorAll(".animate-skeleton-teal").length;
}

const trendingMock = vi.mocked(fetchTrending);

beforeEach(() => {
  trendingMock.mockReset();
});

describe("TrendingCarousel error + empty truth", () => {
  it("shows the skeleton while the initial request is pending", async () => {
    const pending = deferred<TrendingResponse>();
    trendingMock.mockReturnValueOnce(pending.promise);

    const { container } = render(<TrendingCarousel />);

    expect(skeletonCount(container)).toBeGreaterThan(0);
    expect(screen.queryByText(ERROR_COPY)).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve(NONEMPTY);
    });
  });

  it("requests the expected trending window", async () => {
    trendingMock.mockResolvedValue(NONEMPTY);

    render(<TrendingCarousel />);

    expect(trendingMock).toHaveBeenCalledWith({ radius_km: 5, minutes: 60 });
    expect(await screen.findByText("Paneer Tikka")).toBeInTheDocument();
  });

  it("renders a dish card on non-empty success", async () => {
    trendingMock.mockResolvedValue(NONEMPTY);

    render(<TrendingCarousel />);

    expect(await screen.findByText("Paneer Tikka")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("30 sold")).toBeInTheDocument();
  });

  it("shows the window subtitle on non-empty success", async () => {
    trendingMock.mockResolvedValue(NONEMPTY);

    render(<TrendingCarousel />);

    expect(await screen.findByText("Last 60 min · 5 km")).toBeInTheDocument();
  });

  it("shows the bounded empty copy for a valid empty success", async () => {
    trendingMock.mockResolvedValue(EMPTY);

    render(<TrendingCarousel />);

    expect(await screen.findByText(EMPTY_COPY)).toBeInTheDocument();
  });

  it("marks the empty copy as a polite live region, not an alert", async () => {
    trendingMock.mockResolvedValue(EMPTY);

    render(<TrendingCarousel />);

    const message = await screen.findByText(EMPTY_COPY);
    expect(message).toHaveAttribute("aria-live", "polite");
    expect(message).not.toHaveAttribute("role", "alert");
  });

  it("shows the bounded error copy on failure", async () => {
    trendingMock.mockRejectedValue(new Error("raw secret message"));

    render(<TrendingCarousel />);

    expect(await screen.findByText(ERROR_COPY)).toBeInTheDocument();
    expect(screen.queryByText("raw secret message")).not.toBeInTheDocument();
  });

  it("renders the failure as role='alert' and never the raw error", async () => {
    trendingMock.mockRejectedValue(new Error("backend exploded"));

    render(<TrendingCarousel />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ERROR_COPY);
    expect(screen.queryByText("backend exploded")).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
  });

  it("shows neither skeleton nor error for a valid empty success", async () => {
    trendingMock.mockResolvedValue(EMPTY);

    const { container } = render(<TrendingCarousel />);

    await screen.findByText(EMPTY_COPY);
    expect(skeletonCount(container)).toBe(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores a late success after unmount", async () => {
    const pending = deferred<TrendingResponse>();
    trendingMock.mockReturnValueOnce(pending.promise);

    const { unmount } = render(<TrendingCarousel />);
    unmount();

    await act(async () => {
      pending.resolve(NONEMPTY);
    });

    expect(screen.queryByText("Paneer Tikka")).not.toBeInTheDocument();
  });

  it("ignores a late failure after unmount", async () => {
    const pending = deferred<TrendingResponse>();
    trendingMock.mockReturnValueOnce(pending.promise);

    const { unmount } = render(<TrendingCarousel />);
    unmount();

    await act(async () => {
      pending.reject(new Error("late boom"));
    });

    expect(screen.queryByText(ERROR_COPY)).not.toBeInTheDocument();
  });
});
