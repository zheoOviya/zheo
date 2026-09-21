import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DietaryFilter } from "../DietaryFilter";
import { filterMenuByDietary, type MenuItem } from "@/lib/api";

vi.mock("@/lib/api", () => ({ filterMenuByDietary: vi.fn() }));

const VEG_ITEMS: MenuItem[] = [
  {
    id: "m1",
    restaurant_id: "r1",
    name: "Paneer Wrap",
    price: 149,
    dietary_tags: { VEG: true },
    customizations: [],
    is_available: true,
    spice_level: 2,
    image_url: null,
  },
];

const JAIN_ITEMS: MenuItem[] = [
  {
    id: "m2",
    restaurant_id: "r1",
    name: "Jain Thali",
    price: 249,
    dietary_tags: { VEG: true, JAIN: true },
    customizations: [],
    is_available: true,
    spice_level: 1,
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

const filterMock = vi.mocked(filterMenuByDietary);

function clickTag(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

beforeEach(() => {
  filterMock.mockReset();
});

describe("DietaryFilter truth states", () => {
  it("forwards a valid non-empty filter response to onResults", async () => {
    filterMock.mockResolvedValue(VEG_ITEMS);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");

    await waitFor(() => expect(onResults).toHaveBeenCalledWith(VEG_ITEMS));
    expect(filterMock).toHaveBeenCalledWith(["VEG"]);
  });

  it("forwards a valid empty filter response to onResults", async () => {
    filterMock.mockResolvedValue([]);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");

    await waitFor(() => expect(onResults).toHaveBeenCalledWith([]));
  });

  it("clears results on deselect-all without issuing a request", async () => {
    filterMock.mockResolvedValue(VEG_ITEMS);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");
    await waitFor(() => expect(onResults).toHaveBeenCalledWith(VEG_ITEMS));

    clickTag("VEG");

    await waitFor(() => expect(onResults).toHaveBeenLastCalledWith([]));
    expect(filterMock).toHaveBeenCalledTimes(1);
  });

  it("shows a bounded local error on failure", async () => {
    filterMock.mockRejectedValue(new Error("Request failed"));
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't update filters",
    );
  });

  it("does not fabricate an empty result on failure", async () => {
    filterMock.mockRejectedValue(new Error("Request failed"));
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");

    await screen.findByRole("alert");
    expect(onResults).not.toHaveBeenCalled();
  });

  it("preserves the previous truthful result when a later filter fails", async () => {
    filterMock.mockResolvedValueOnce(VEG_ITEMS);
    filterMock.mockRejectedValueOnce(new Error("Request failed"));
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");
    await waitFor(() => expect(onResults).toHaveBeenCalledWith(VEG_ITEMS));

    clickTag("JAIN");

    await screen.findByRole("alert");
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenLastCalledWith(VEG_ITEMS);
  });

  it("ignores a stale success that resolves after a newer toggle", async () => {
    const first = deferred<MenuItem[]>();
    const second = deferred<MenuItem[]>();
    filterMock.mockReturnValueOnce(first.promise);
    filterMock.mockReturnValueOnce(second.promise);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");
    clickTag("JAIN");

    second.resolve(JAIN_ITEMS);
    await waitFor(() => expect(onResults).toHaveBeenCalledWith(JAIN_ITEMS));

    first.resolve(VEG_ITEMS);

    await waitFor(() => expect(filterMock).toHaveBeenCalledTimes(2));
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenLastCalledWith(JAIN_ITEMS);
  });

  it("ignores a stale failure that rejects after a newer toggle settles", async () => {
    const first = deferred<MenuItem[]>();
    const second = deferred<MenuItem[]>();
    filterMock.mockReturnValueOnce(first.promise);
    filterMock.mockReturnValueOnce(second.promise);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");
    clickTag("JAIN");

    second.resolve(JAIN_ITEMS);
    await waitFor(() => expect(onResults).toHaveBeenCalledWith(JAIN_ITEMS));

    first.reject(new Error("Request failed"));

    await waitFor(() => expect(filterMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onResults).toHaveBeenLastCalledWith(JAIN_ITEMS);
  });

  it("lets deselect-all invalidate an older in-flight response", async () => {
    const first = deferred<MenuItem[]>();
    filterMock.mockReturnValueOnce(first.promise);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");
    clickTag("VEG");

    await waitFor(() => expect(onResults).toHaveBeenLastCalledWith([]));

    first.resolve(VEG_ITEMS);

    await waitFor(() => expect(onResults).toHaveBeenCalledTimes(1));
    expect(onResults).toHaveBeenLastCalledWith([]);
  });

  it("shows a bounded no-matches message for a valid empty result", async () => {
    filterMock.mockResolvedValue([]);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");

    expect(await screen.findByText("No matching dishes")).toBeInTheDocument();
    await waitFor(() => expect(onResults).toHaveBeenCalledWith([]));
  });

  it("does not show no-matches for a non-empty result", async () => {
    filterMock.mockResolvedValue(VEG_ITEMS);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");

    await waitFor(() => expect(onResults).toHaveBeenCalledWith(VEG_ITEMS));
    expect(screen.queryByText("No matching dishes")).not.toBeInTheDocument();
  });

  it("shows the existing error and no no-matches on failure", async () => {
    filterMock.mockRejectedValue(new Error("Request failed"));
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't update filters",
    );
    expect(screen.queryByText("No matching dishes")).not.toBeInTheDocument();
  });

  it("clears no-matches when the filter is deselected", async () => {
    filterMock.mockResolvedValue([]);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");
    expect(await screen.findByText("No matching dishes")).toBeInTheDocument();

    clickTag("VEG");

    await waitFor(() =>
      expect(screen.queryByText("No matching dishes")).not.toBeInTheDocument(),
    );
    expect(onResults).toHaveBeenLastCalledWith([]);
  });

  it("clears a prior no-matches message while a newer request is loading", async () => {
    const first = deferred<MenuItem[]>();
    const second = deferred<MenuItem[]>();
    filterMock.mockReturnValueOnce(first.promise);
    filterMock.mockReturnValueOnce(second.promise);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");
    first.resolve([]);
    expect(await screen.findByText("No matching dishes")).toBeInTheDocument();

    clickTag("JAIN");

    expect(screen.queryByText("No matching dishes")).not.toBeInTheDocument();
    expect(screen.getByText("Filtering…")).toBeInTheDocument();

    second.resolve(JAIN_ITEMS);
    await waitFor(() => expect(onResults).toHaveBeenCalledWith(JAIN_ITEMS));
  });

  it("ignores a stale empty success after a newer non-empty success", async () => {
    const first = deferred<MenuItem[]>();
    const second = deferred<MenuItem[]>();
    filterMock.mockReturnValueOnce(first.promise);
    filterMock.mockReturnValueOnce(second.promise);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");
    clickTag("JAIN");

    second.resolve(JAIN_ITEMS);
    await waitFor(() => expect(onResults).toHaveBeenCalledWith(JAIN_ITEMS));

    first.resolve([]);

    await waitFor(() => expect(filterMock).toHaveBeenCalledTimes(2));
    expect(onResults).toHaveBeenLastCalledWith(JAIN_ITEMS);
    expect(screen.queryByText("No matching dishes")).not.toBeInTheDocument();
  });

  it("does not let a stale failure disturb current no-matches truth", async () => {
    const first = deferred<MenuItem[]>();
    const second = deferred<MenuItem[]>();
    filterMock.mockReturnValueOnce(first.promise);
    filterMock.mockReturnValueOnce(second.promise);
    const onResults = vi.fn();

    render(<DietaryFilter onResults={onResults} />);
    clickTag("VEG");
    clickTag("JAIN");

    second.resolve([]);
    expect(await screen.findByText("No matching dishes")).toBeInTheDocument();

    first.reject(new Error("Request failed"));

    await waitFor(() => expect(filterMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("No matching dishes")).toBeInTheDocument();
  });
});
