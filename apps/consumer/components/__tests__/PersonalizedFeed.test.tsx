import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { PersonalizedFeed } from "../PersonalizedFeed";
import {
  fetchPersonalizedHomepage,
  type PersonalizedHomepage,
  type Restaurant,
} from "@/lib/api";
import { useAuthStore } from "@/lib/store";

vi.mock("@/lib/api", () => ({ fetchPersonalizedHomepage: vi.fn() }));

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

function restaurant(id: string, name: string): Restaurant {
  return {
    id,
    name,
    is_active: true,
    lat: null,
    lng: null,
    pickup_eta_min: 15,
    rating: 4.5,
    cuisines: ["Veg"],
    price_for_one: 200,
    cover_image: null,
  };
}

function feed(
  id: string,
  name: string,
  strategy: "rule_based" | "ml_weighted" = "rule_based",
): PersonalizedHomepage {
  return {
    user_profile: {
      is_cold_start: strategy === "rule_based",
      past_order_count: 0,
      inferred_dietary_tags: [],
      strategy,
    },
    personalized_restaurants: [
      { restaurant: restaurant(id, name), reason: "Because you liked similar places", score: 0.8 },
    ],
    surprise_restaurant: null,
  };
}

const EMPTY_FEED: PersonalizedHomepage = {
  user_profile: {
    is_cold_start: true,
    past_order_count: 0,
    inferred_dietary_tags: [],
    strategy: "rule_based",
  },
  personalized_restaurants: [],
  surprise_restaurant: null,
};

const ANON_FEED = feed("anon", "Anon Place");
const AUTH_FEED = feed("auth", "Auth Place", "ml_weighted");
const FEED_A = feed("a", "Feed A");
const FEED_B = feed("b", "Feed B");

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

const feedMock = vi.mocked(fetchPersonalizedHomepage);

beforeEach(() => {
  feedMock.mockReset();
  useAuthStore.setState({ accessToken: null });
});

describe("PersonalizedFeed token-transition truth", () => {
  it("shows the skeleton for the initial anonymous request", async () => {
    const pending = deferred<PersonalizedHomepage>();
    feedMock.mockReturnValueOnce(pending.promise);

    const { container } = render(<PersonalizedFeed />);

    expect(skeletonCount(container)).toBeGreaterThan(0);
    expect(feedMock).toHaveBeenCalledWith(undefined);

    await act(async () => {
      pending.resolve(ANON_FEED);
    });
  });

  it("renders the feed after an anonymous success", async () => {
    feedMock.mockResolvedValue(ANON_FEED);

    render(<PersonalizedFeed />);

    expect(await screen.findByText("Anon Place")).toBeInTheDocument();
    expect(feedMock).toHaveBeenCalledWith(undefined);
  });

  it("passes the access token and renders the personalized feed", async () => {
    useAuthStore.setState({ accessToken: "tok-a" });
    feedMock.mockResolvedValue(AUTH_FEED);

    render(<PersonalizedFeed />);

    expect(await screen.findByText("Auth Place")).toBeInTheDocument();
    expect(feedMock).toHaveBeenCalledWith("tok-a");
    expect(screen.getByText("From your history")).toBeInTheDocument();
  });

  it("shows bounded copy on failure and never the raw error", async () => {
    feedMock.mockRejectedValue(new Error("raw secret message"));

    render(<PersonalizedFeed />);

    expect(await screen.findByText("Couldn't load personalized picks")).toBeInTheDocument();
    expect(screen.queryByText("raw secret message")).not.toBeInTheDocument();
  });

  it("renders the failure copy with role='alert'", async () => {
    feedMock.mockRejectedValue(new Error("boom"));

    render(<PersonalizedFeed />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load personalized picks",
    );
  });

  it("clears a prior error immediately when the token changes", async () => {
    const second = deferred<PersonalizedHomepage>();
    feedMock.mockRejectedValueOnce(new Error("boom"));
    feedMock.mockReturnValueOnce(second.promise);

    const { container } = render(<PersonalizedFeed />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    act(() => {
      useAuthStore.setState({ accessToken: "tok-b" });
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(skeletonCount(container)).toBeGreaterThan(0);

    await act(async () => {
      second.resolve(FEED_B);
    });
  });

  it("shows a success that follows a prior failure", async () => {
    const second = deferred<PersonalizedHomepage>();
    feedMock.mockRejectedValueOnce(new Error("boom"));
    feedMock.mockReturnValueOnce(second.promise);

    render(<PersonalizedFeed />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    act(() => {
      useAuthStore.setState({ accessToken: "tok-b" });
    });
    await act(async () => {
      second.resolve(FEED_B);
    });

    expect(await screen.findByText("Feed B")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("removes a prior feed immediately when the token changes", async () => {
    const second = deferred<PersonalizedHomepage>();
    feedMock.mockResolvedValueOnce(FEED_A);
    feedMock.mockReturnValueOnce(second.promise);

    render(<PersonalizedFeed />);
    expect(await screen.findByText("Feed A")).toBeInTheDocument();

    act(() => {
      useAuthStore.setState({ accessToken: "tok-b" });
    });

    expect(screen.queryByText("Feed A")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(FEED_B);
    });
    expect(await screen.findByText("Feed B")).toBeInTheDocument();
  });

  it("shows the skeleton again during a token-change request", async () => {
    const second = deferred<PersonalizedHomepage>();
    feedMock.mockResolvedValueOnce(FEED_A);
    feedMock.mockReturnValueOnce(second.promise);

    const { container } = render(<PersonalizedFeed />);
    expect(await screen.findByText("Feed A")).toBeInTheDocument();
    expect(skeletonCount(container)).toBe(0);

    act(() => {
      useAuthStore.setState({ accessToken: "tok-b" });
    });

    expect(skeletonCount(container)).toBeGreaterThan(0);

    await act(async () => {
      second.resolve(FEED_B);
    });
  });

  it("does not keep the anonymous feed visible when auth appears", async () => {
    const second = deferred<PersonalizedHomepage>();
    feedMock.mockResolvedValueOnce(ANON_FEED);
    feedMock.mockReturnValueOnce(second.promise);

    render(<PersonalizedFeed />);
    expect(await screen.findByText("Anon Place")).toBeInTheDocument();

    act(() => {
      useAuthStore.setState({ accessToken: "tok-a" });
    });

    expect(screen.queryByText("Anon Place")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(AUTH_FEED);
    });
    expect(await screen.findByText("Auth Place")).toBeInTheDocument();
  });

  it("does not keep the authenticated feed visible on logout", async () => {
    useAuthStore.setState({ accessToken: "tok-a" });
    const second = deferred<PersonalizedHomepage>();
    feedMock.mockResolvedValueOnce(AUTH_FEED);
    feedMock.mockReturnValueOnce(second.promise);

    render(<PersonalizedFeed />);
    expect(await screen.findByText("Auth Place")).toBeInTheDocument();

    act(() => {
      useAuthStore.setState({ accessToken: null });
    });

    expect(screen.queryByText("Auth Place")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(ANON_FEED);
    });
  });

  it("does not keep feed A visible when token B replaces it", async () => {
    useAuthStore.setState({ accessToken: "tok-a" });
    const second = deferred<PersonalizedHomepage>();
    feedMock.mockResolvedValueOnce(FEED_A);
    feedMock.mockReturnValueOnce(second.promise);

    render(<PersonalizedFeed />);
    expect(await screen.findByText("Feed A")).toBeInTheDocument();

    act(() => {
      useAuthStore.setState({ accessToken: "tok-b" });
    });

    expect(screen.queryByText("Feed A")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(FEED_B);
    });
    expect(await screen.findByText("Feed B")).toBeInTheDocument();
  });

  it("ignores a stale success from the superseded token", async () => {
    const first = deferred<PersonalizedHomepage>();
    const second = deferred<PersonalizedHomepage>();
    feedMock.mockReturnValueOnce(first.promise);
    feedMock.mockReturnValueOnce(second.promise);

    render(<PersonalizedFeed />);

    act(() => {
      useAuthStore.setState({ accessToken: "tok-b" });
    });
    await act(async () => {
      second.resolve(FEED_B);
    });
    expect(await screen.findByText("Feed B")).toBeInTheDocument();

    await act(async () => {
      first.resolve(FEED_A);
    });

    expect(screen.queryByText("Feed A")).not.toBeInTheDocument();
    expect(screen.getByText("Feed B")).toBeInTheDocument();
  });

  it("ignores a stale failure from the superseded token", async () => {
    const first = deferred<PersonalizedHomepage>();
    const second = deferred<PersonalizedHomepage>();
    feedMock.mockReturnValueOnce(first.promise);
    feedMock.mockReturnValueOnce(second.promise);

    render(<PersonalizedFeed />);

    act(() => {
      useAuthStore.setState({ accessToken: "tok-b" });
    });
    await act(async () => {
      second.resolve(FEED_B);
    });
    expect(await screen.findByText("Feed B")).toBeInTheDocument();

    await act(async () => {
      first.reject(new Error("stale boom"));
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Feed B")).toBeInTheDocument();
  });

  it("ignores a later success or failure after unmount", async () => {
    const okPending = deferred<PersonalizedHomepage>();
    feedMock.mockReturnValueOnce(okPending.promise);
    const first = render(<PersonalizedFeed />);
    first.unmount();

    await act(async () => {
      okPending.resolve(ANON_FEED);
    });
    expect(screen.queryByText("Anon Place")).not.toBeInTheDocument();

    const failPending = deferred<PersonalizedHomepage>();
    feedMock.mockReturnValueOnce(failPending.promise);
    const second = render(<PersonalizedFeed />);
    second.unmount();

    await act(async () => {
      failPending.reject(new Error("late boom"));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders a valid empty success without loading or error", async () => {
    feedMock.mockResolvedValue(EMPTY_FEED);

    const { container } = render(<PersonalizedFeed />);

    expect(await screen.findByText("Fresh picks")).toBeInTheDocument();
    expect(skeletonCount(container)).toBe(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
