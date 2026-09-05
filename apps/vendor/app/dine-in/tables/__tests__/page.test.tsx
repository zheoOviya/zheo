import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import DineInTableBoardPage from "../page";
import type { DineInTableSessionStatus, VendorTableBoardRow } from "@/lib/api";

const REST_A = "a0000000-0000-4000-8000-000000000001";
const REST_B = "a0000000-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  fetchDineInTables: vi.fn(),
}));

const hookState = vi.hoisted(() => ({
  activeId: "a0000000-0000-4000-8000-000000000001" as string | null,
}));

vi.mock("@/hooks/useActiveRestaurant", () => ({
  useActiveRestaurant: () => ({ activeRestaurantId: hookState.activeId }),
}));

vi.mock("@/lib/api", () => ({
  fetchDineInTables: mocks.fetchDineInTables,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function liveSession(
  status: DineInTableSessionStatus,
  overrides: Partial<NonNullable<VendorTableBoardRow["session"]>> = {},
): NonNullable<VendorTableBoardRow["session"]> {
  return {
    id: "sess-0000-0000-1234abcd",
    status,
    opened_at: "2026-09-04T05:00:00.000Z",
    bill_requested_at: null,
    ...overrides,
  };
}

function tableRow(
  opts: {
    table?: Partial<VendorTableBoardRow["table"]>;
    zone?: VendorTableBoardRow["zone"];
    session?: VendorTableBoardRow["session"];
    open_order_count?: number;
    open_request_count?: number;
  } = {},
): VendorTableBoardRow {
  return {
    table: { id: "t1", label: "T1", seat_count: 4, is_active: true, ...opts.table },
    zone: opts.zone === undefined ? { id: "z1", name: "Patio" } : opts.zone,
    session: opts.session === undefined ? null : opts.session,
    open_order_count: opts.open_order_count ?? 0,
    open_request_count: opts.open_request_count ?? 0,
  };
}

const POLL_MS = 15_000;

async function flush() {
  await act(async () => {});
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// StatCard labels are plain <p> elements; the same words (e.g. "Free") can also
// appear inside status chips (<span>) and the page subtitle, so match only the
// label paragraph and climb to its card container.
function statCard(label: string): HTMLElement {
  const labelEl = screen.getAllByText(label).find((el) => el.tagName === "P");
  if (!labelEl) throw new Error(`StatCard "${label}" label not found`);
  const card = labelEl.parentElement;
  if (!card) throw new Error(`StatCard "${label}" has no parent`);
  return card;
}

// Free/Disabled pills are <span> chips; "Free" also names a StatCard paragraph.
function chipText(label: string): string[] {
  return screen
    .getAllByText(label)
    .filter((el) => el.tagName === "SPAN")
    .map((el) => el.textContent ?? "");
}

beforeEach(() => {
  hookState.activeId = REST_A;
  mocks.fetchDineInTables.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe("Dine-In table board page", () => {
  it("renders free and occupied rows with truthful status chips and no actions", async () => {
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({
        table: { id: "t1", label: "T1", seat_count: 4 },
        zone: { id: "z1", name: "Patio" },
      }),
      tableRow({
        table: { id: "t2", label: "T2", seat_count: 2 },
        session: liveSession("ACTIVE", { id: "sess-0000-0000-1111abcd" }),
        open_order_count: 2,
        open_request_count: 1,
      }),
      tableRow({
        table: { id: "t3", label: "T3", seat_count: 6 },
        session: liveSession("OPEN", { id: "sess-0000-0000-2222bcde" }),
      }),
      tableRow({
        table: { id: "t4", label: "T4", seat_count: 4 },
        session: liveSession("BILL_REQUESTED", {
          id: "sess-0000-0000-3333cdef",
          bill_requested_at: "2026-09-04T05:30:00.000Z",
        }),
      }),
      tableRow({
        table: { id: "t5", label: "T5", seat_count: 4 },
        session: liveSession("PAYMENT_PENDING", { id: "sess-0000-0000-4444def0" }),
      }),
    ]);

    render(<DineInTableBoardPage />);

    expect(await screen.findByText("T1")).toBeDefined();
    expect(screen.getAllByText("Patio").length).toBeGreaterThan(0);
    expect(chipText("Free")).toHaveLength(1);
    expect(chipText("Active")).toHaveLength(1);
    expect(chipText("Open")).toHaveLength(1);
    expect(chipText("Bill requested")).toHaveLength(1);
    expect(chipText("Payment pending")).toHaveLength(1);

    // Occupied cards carry the short session id, opened time, and open counts.
    expect(screen.getByText(/ABCD/)).toBeDefined();
    expect(screen.getAllByText(/Opened/)).toHaveLength(4);
    const activeCard = screen.getByLabelText(/Table T2, .*active$/);
    expect(within(activeCard).getByText(/2 open orders/)).toBeDefined();
    expect(within(activeCard).getByText(/1 open request/)).toBeDefined();

    // The BILL_REQUESTED card also surfaces bill_requested_at in the same line.
    const billCard = screen.getByLabelText(/Table T4, .*bill requested$/);
    expect(within(billCard).getByText(/Opened .*Bill requested/)).toBeDefined();

    // Read-only board: no mutation buttons anywhere.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the four summary stat cards derived from live sessions", async () => {
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({
        table: { id: "t1", label: "T1" },
        session: liveSession("ACTIVE"),
        open_order_count: 1,
        open_request_count: 2,
      }),
      tableRow({
        table: { id: "t2", label: "T2" },
        session: liveSession("PAYMENT_PENDING"),
        open_request_count: 1,
      }),
      tableRow({ table: { id: "t3", label: "T3" } }),
      tableRow({ table: { id: "t4", label: "T4", is_active: false } }),
    ]);

    render(<DineInTableBoardPage />);

    expect(await screen.findByText("Total tables")).toBeDefined();
    expect(within(statCard("Total tables")).getByText("4")).toBeDefined();
    expect(within(statCard("Occupied")).getByText("2")).toBeDefined();
    expect(within(statCard("Free")).getByText("2")).toBeDefined();
    expect(within(statCard("Open requests")).getByText("3")).toBeDefined();
  });

  it("renders server order exactly with no client-side sorting", async () => {
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({ table: { id: "t2", label: "T2" }, session: liveSession("OPEN") }),
      tableRow({ table: { id: "t10", label: "T10" } }),
      tableRow({ table: { id: "t1", label: "T1" }, session: liveSession("ACTIVE") }),
    ]);

    render(<DineInTableBoardPage />);

    expect(await screen.findByText("T2")).toBeDefined();
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("T2");
    expect(items[1]?.textContent).toContain("T10");
    expect(items[2]?.textContent).toContain("T1");
  });

  it("keeps disabled as an independent pill that never replaces occupancy", async () => {
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({
        table: { id: "t1", label: "T1", is_active: false },
        session: liveSession("ACTIVE"),
      }),
      tableRow({ table: { id: "t2", label: "T2", is_active: false } }),
    ]);

    render(<DineInTableBoardPage />);

    // Disabled + occupied: the occupancy chip and the Disabled pill coexist.
    const occupiedDisabled = await screen.findByLabelText(/Table T1, .*active, disabled$/);
    expect(within(occupiedDisabled).getByText("Active")).toBeDefined();
    expect(within(occupiedDisabled).getByText("Disabled")).toBeDefined();

    // Disabled + free: the Free chip and the Disabled pill coexist.
    const freeDisabled = screen.getByLabelText(/Table T2, .*free, disabled$/);
    expect(within(freeDisabled).getByText("Free")).toBeDefined();
    expect(within(freeDisabled).getByText("Disabled")).toBeDefined();
  });

  it("omits session and count clutter on free rows", async () => {
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({ table: { id: "t1", label: "T1" } }),
      tableRow({
        table: { id: "t2", label: "T2" },
        session: liveSession("ACTIVE"),
        open_order_count: 3,
      }),
    ]);

    render(<DineInTableBoardPage />);

    const freeCard = await screen.findByLabelText(/Table T1, .*free$/);
    expect(within(freeCard).queryByText(/Opened/)).toBeNull();
    expect(within(freeCard).queryByText(/open orders/)).toBeNull();

    const occupiedCard = screen.getByLabelText(/Table T2, .*active$/);
    expect(within(occupiedCard).getByText(/Opened/)).toBeDefined();
    expect(within(occupiedCard).getByText(/3 open orders/)).toBeDefined();
  });

  it("waits for the restaurant store before fetching (spinner while not ready)", async () => {
    hookState.activeId = null;

    const { rerender } = render(<DineInTableBoardPage />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeDefined();
    expect(mocks.fetchDineInTables).not.toHaveBeenCalled();

    hookState.activeId = REST_A;
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({ table: { id: "t1", label: "T1" } }),
    ]);
    await act(async () => {
      rerender(<DineInTableBoardPage />);
    });

    expect(await screen.findByText("T1")).toBeDefined();
    expect(mocks.fetchDineInTables).toHaveBeenCalledWith(REST_A);
  });

  it("shows a retry panel on an initial fetch failure, then recovers on switch", async () => {
    mocks.fetchDineInTables.mockRejectedValue(new Error("boom"));

    const { rerender } = render(<DineInTableBoardPage />);

    expect(await screen.findByText(/Couldn't load the table board/)).toBeDefined();

    // A later successful load (here via restaurant switch) replaces the panel.
    hookState.activeId = REST_B;
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({ table: { id: "t1", label: "T1" } }),
    ]);
    await act(async () => {
      rerender(<DineInTableBoardPage />);
    });
    expect(await screen.findByText("T1")).toBeDefined();
    expect(screen.queryByText(/Couldn't load the table board/)).toBeNull();
  });

  it("shows an empty state when the board has no tables", async () => {
    render(<DineInTableBoardPage />);

    expect(await screen.findByText("No tables yet")).toBeDefined();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("keeps stale rows and shows an error banner when a later poll fails", async () => {
    vi.useFakeTimers();
    mocks.fetchDineInTables
      .mockResolvedValueOnce([tableRow({ table: { id: "t1", label: "T1" } })])
      .mockRejectedValueOnce(new Error("boom"));

    render(<DineInTableBoardPage />);
    await flush();
    await flush();

    expect(screen.getByText("T1")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();

    await tick(POLL_MS);

    expect(screen.getByRole("alert")).toBeDefined();
    // Rows are retained instead of blanking the board on a transient poll error.
    expect(screen.getByText("T1")).toBeDefined();
    expect(screen.getByText("Total tables")).toBeDefined();
  });

  it("refreshes rows on the 15s cadence without ever blanking", async () => {
    vi.useFakeTimers();
    mocks.fetchDineInTables
      .mockResolvedValueOnce([tableRow({ table: { id: "t1", label: "T1" } })])
      .mockResolvedValueOnce([tableRow({ table: { id: "t2", label: "T2" } })]);

    render(<DineInTableBoardPage />);
    await flush();
    await flush();

    expect(screen.getByText("T1")).toBeDefined();
    expect(mocks.fetchDineInTables).toHaveBeenCalledTimes(1);

    // Nothing fires before the 15s window elapses.
    await tick(10_000);
    expect(mocks.fetchDineInTables).toHaveBeenCalledTimes(1);

    // At the 15s mark the next snapshot replaces the rows (no spinner flash).
    await tick(5_000);
    await flush();
    expect(mocks.fetchDineInTables).toHaveBeenCalledTimes(2);
    expect(screen.getByText("T2")).toBeDefined();
    expect(screen.queryByText("T1")).toBeNull();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
    expect(screen.getByText("Total tables")).toBeDefined();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({ table: { id: "t1", label: "T1" } }),
    ]);

    const { unmount } = render(<DineInTableBoardPage />);
    await flush();
    await flush();
    expect(mocks.fetchDineInTables).toHaveBeenCalledTimes(1);

    unmount();
    await tick(POLL_MS * 2);
    // No post-unmount fetches or state updates.
    expect(mocks.fetchDineInTables).toHaveBeenCalledTimes(1);
  });

  it("switching away from a loaded board wipes to the store spinner", async () => {
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({ table: { id: "t1", label: "T1" } }),
    ]);

    const { rerender } = render(<DineInTableBoardPage />);
    expect(await screen.findByText("T1")).toBeDefined();

    // Store loses the active restaurant: board falls back to the spinner and
    // issues no fetch while there is nothing to poll against.
    hookState.activeId = null;
    await act(async () => {
      rerender(<DineInTableBoardPage />);
    });
    expect(screen.getByRole("status", { name: "Loading" })).toBeDefined();
    expect(screen.queryByText("T1")).toBeNull();
    const callsBeforeSwitchBack = mocks.fetchDineInTables.mock.calls.length;

    // A new restaurant starts from a clean slate (old rows never resurface).
    hookState.activeId = REST_B;
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({ table: { id: "b1", label: "B1" } }),
    ]);
    await act(async () => {
      rerender(<DineInTableBoardPage />);
    });
    expect(await screen.findByText("B1")).toBeDefined();
    expect(screen.queryByText("T1")).toBeNull();
    expect(mocks.fetchDineInTables.mock.calls.length).toBe(callsBeforeSwitchBack + 1);
    expect(mocks.fetchDineInTables).toHaveBeenLastCalledWith(REST_B);
  });

  it("discards a stale response from the previous restaurant after a switch", async () => {
    vi.useFakeTimers();

    let resolveOld: (rows: VendorTableBoardRow[]) => void = () => {};
    const oldFetch = new Promise<VendorTableBoardRow[]>((resolve) => {
      resolveOld = resolve;
    });
    mocks.fetchDineInTables.mockImplementationOnce(() => oldFetch);

    const { rerender } = render(<DineInTableBoardPage />);
    await flush();
    expect(mocks.fetchDineInTables).toHaveBeenCalledTimes(1);
    expect(mocks.fetchDineInTables).toHaveBeenCalledWith(REST_A);

    // Switch restaurants while the old-restaurant request is still in flight.
    hookState.activeId = REST_B;
    mocks.fetchDineInTables.mockImplementationOnce(() =>
      Promise.resolve([tableRow({ table: { id: "b1", label: "B1" } })]),
    );
    await act(async () => {
      rerender(<DineInTableBoardPage />);
    });
    await flush();

    expect(screen.getByText("B1")).toBeDefined();

    // The late old-restaurant snapshot must be discarded, never rendered.
    resolveOld([tableRow({ table: { id: "a1", label: "A1" } })]);
    await flush();

    expect(screen.getByText("B1")).toBeDefined();
    expect(screen.queryByText("A1")).toBeNull();
  });

  it("announces the board summary via the polite sr-only region", async () => {
    mocks.fetchDineInTables.mockResolvedValue([
      tableRow({ table: { id: "t1", label: "T1" }, session: liveSession("ACTIVE") }),
      tableRow({ table: { id: "t2", label: "T2" } }),
    ]);

    render(<DineInTableBoardPage />);

    expect(await screen.findByText(/1 of 2 tables occupied/)).toBeDefined();
  });
});
