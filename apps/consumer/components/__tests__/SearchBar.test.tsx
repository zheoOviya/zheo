import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SearchBar } from "../SearchBar";
import { searchAutocomplete, type SearchResult } from "@/lib/api";

vi.mock("@/lib/api", () => ({ searchAutocomplete: vi.fn() }));

const RESULTS: SearchResult[] = [
  { type: "dish", id: "d1", name: "Paneer Wrap", restaurant_id: "r1" },
];

const STALE: SearchResult[] = [
  { type: "dish", id: "d2", name: "Stale Dish", restaurant_id: "r1" },
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

const searchMock = vi.mocked(searchAutocomplete);

const input = () => screen.getByRole("searchbox");
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  searchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchBar truth states", () => {
  it("issues no request for a query shorter than 2 characters", async () => {
    render(<SearchBar onSelect={vi.fn()} />);

    type("p");
    await advance(1000);

    expect(searchMock).not.toHaveBeenCalled();
  });

  it("waits for the 350ms debounce before requesting", async () => {
    searchMock.mockResolvedValue(RESULTS);

    render(<SearchBar onSelect={vi.fn()} />);
    type("pa");

    await advance(349);
    expect(searchMock).not.toHaveBeenCalled();

    await advance(1);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith("pa", expect.anything());
  });

  it("renders the result list for a successful non-empty search", async () => {
    searchMock.mockResolvedValue(RESULTS);

    render(<SearchBar onSelect={vi.fn()} />);
    type("pa");
    await advance(350);

    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();
    expect(
      screen.queryByText("No matching dishes or restaurants"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the no-matches message for a valid empty result", async () => {
    searchMock.mockResolvedValue([]);

    render(<SearchBar onSelect={vi.fn()} />);
    type("zz");
    await advance(350);

    expect(
      screen.getByText("No matching dishes or restaurants"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the error message on failure and never the empty copy", async () => {
    searchMock.mockRejectedValue(new Error("boom"));

    render(<SearchBar onSelect={vi.fn()} />);
    type("zz");
    await advance(350);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't search right now",
    );
    expect(
      screen.queryByText("No matching dishes or restaurants"),
    ).not.toBeInTheDocument();
  });

  it("clears previous results immediately when a new query starts", async () => {
    const first = deferred<SearchResult[]>();
    const second = deferred<SearchResult[]>();
    searchMock.mockReturnValueOnce(first.promise);
    searchMock.mockReturnValueOnce(second.promise);

    render(<SearchBar onSelect={vi.fn()} />);
    type("pa");
    await advance(350);
    await act(async () => {
      first.resolve(RESULTS);
    });
    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();

    type("paneer");

    expect(screen.queryByText("Paneer Wrap")).not.toBeInTheDocument();

    await advance(350);
    await act(async () => {
      second.resolve(RESULTS);
    });
    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();
  });

  it("clears a prior no-matches message while a new query loads", async () => {
    const first = deferred<SearchResult[]>();
    const second = deferred<SearchResult[]>();
    searchMock.mockReturnValueOnce(first.promise);
    searchMock.mockReturnValueOnce(second.promise);

    render(<SearchBar onSelect={vi.fn()} />);
    type("zz");
    await advance(350);
    await act(async () => {
      first.resolve([]);
    });
    expect(
      screen.getByText("No matching dishes or restaurants"),
    ).toBeInTheDocument();

    type("zzz");

    expect(
      screen.queryByText("No matching dishes or restaurants"),
    ).not.toBeInTheDocument();

    await advance(350);
    await act(async () => {
      second.resolve(RESULTS);
    });
    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();
  });

  it("clears a prior error message while a new query loads", async () => {
    const first = deferred<SearchResult[]>();
    const second = deferred<SearchResult[]>();
    searchMock.mockReturnValueOnce(first.promise);
    searchMock.mockReturnValueOnce(second.promise);

    render(<SearchBar onSelect={vi.fn()} />);
    type("zz");
    await advance(350);
    await act(async () => {
      first.reject(new Error("boom"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't search right now",
    );

    type("zzz");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await advance(350);
    await act(async () => {
      second.resolve(RESULTS);
    });
    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();
  });

  it("aborts the in-flight request when the query changes", async () => {
    const first = deferred<SearchResult[]>();
    const second = deferred<SearchResult[]>();
    const signals: AbortSignal[] = [];
    searchMock.mockImplementation((_q, signal) => {
      signals.push(signal as AbortSignal);
      return signals.length === 1 ? first.promise : second.promise;
    });

    render(<SearchBar onSelect={vi.fn()} />);
    type("pa");
    await advance(350);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    type("paneer");
    expect(signals[0]!.aborted).toBe(true);

    await advance(350);
    await act(async () => {
      second.resolve(RESULTS);
    });
  });

  it("blocks an aborted stale success from overwriting newer state", async () => {
    const first = deferred<SearchResult[]>();
    const second = deferred<SearchResult[]>();
    searchMock.mockReturnValueOnce(first.promise);
    searchMock.mockReturnValueOnce(second.promise);

    render(<SearchBar onSelect={vi.fn()} />);
    type("pa");
    await advance(350);
    type("paneer");
    await advance(350);
    await act(async () => {
      second.resolve(RESULTS);
    });
    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();

    await act(async () => {
      first.resolve(STALE);
    });

    expect(screen.queryByText("Stale Dish")).not.toBeInTheDocument();
    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();
  });

  it("blocks an aborted stale failure from surfacing an error", async () => {
    const first = deferred<SearchResult[]>();
    const second = deferred<SearchResult[]>();
    searchMock.mockReturnValueOnce(first.promise);
    searchMock.mockReturnValueOnce(second.promise);

    render(<SearchBar onSelect={vi.fn()} />);
    type("pa");
    await advance(350);
    type("paneer");
    await advance(350);
    await act(async () => {
      second.resolve(RESULTS);
    });

    await act(async () => {
      first.reject(new Error("boom"));
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();
  });

  it("blocks a stale finally from clearing newer loading", async () => {
    const first = deferred<SearchResult[]>();
    const second = deferred<SearchResult[]>();
    searchMock.mockReturnValueOnce(first.promise);
    searchMock.mockReturnValueOnce(second.promise);

    const { container } = render(<SearchBar onSelect={vi.fn()} />);
    const spinner = () => container.querySelector(".animate-skeleton-teal");

    type("pa");
    await advance(350);
    type("paneer");

    await act(async () => {
      first.reject(new Error("boom"));
    });
    expect(spinner()).not.toBeNull();

    await advance(350);
    expect(spinner()).not.toBeNull();

    await act(async () => {
      second.resolve(RESULTS);
    });
    expect(spinner()).toBeNull();
    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();
  });

  it("clears results, empty and error states when the query drops below 2", async () => {
    searchMock.mockResolvedValue([]);

    render(<SearchBar onSelect={vi.fn()} />);
    type("zz");
    await advance(350);
    expect(
      screen.getByText("No matching dishes or restaurants"),
    ).toBeInTheDocument();

    type("z");

    expect(
      screen.queryByText("No matching dishes or restaurants"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it("clears a prior non-empty result when the query drops below 2", async () => {
    searchMock.mockResolvedValue(RESULTS);

    render(<SearchBar onSelect={vi.fn()} />);
    type("pa");
    await advance(350);
    expect(screen.getByText("Paneer Wrap")).toBeInTheDocument();

    type("p");

    expect(screen.queryByText("Paneer Wrap")).not.toBeInTheDocument();

    await advance(1000);
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it("clears a prior error when the query drops below 2", async () => {
    searchMock.mockRejectedValue(new Error("boom"));

    render(<SearchBar onSelect={vi.fn()} />);
    type("zz");
    await advance(350);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't search right now",
    );

    type("z");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No matching dishes or restaurants"),
    ).not.toBeInTheDocument();

    await advance(1000);
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it("calls onSelect and clears transient local state on selection", async () => {
    searchMock.mockResolvedValue(RESULTS);
    const onSelect = vi.fn();

    render(<SearchBar onSelect={onSelect} />);
    type("pa");
    await advance(350);

    fireEvent.click(screen.getByText("Paneer Wrap"));

    expect(onSelect).toHaveBeenCalledWith(RESULTS[0]);
    expect(screen.queryByText("Paneer Wrap")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No matching dishes or restaurants"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
