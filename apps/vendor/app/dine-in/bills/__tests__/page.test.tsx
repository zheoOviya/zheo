import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import VendorBillsPage from "../page";
import type { VendorPendingBillRow } from "@/lib/api";
import { formatINR } from "@/lib/format";

const REST_A = "a0000000-0000-4000-8000-000000000001";
const REST_B = "a0000000-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  fetchVendorPendingBills: vi.fn(),
  acknowledgeVendorBill: vi.fn(),
  deliverVendorBill: vi.fn(),
}));

const hookState = vi.hoisted(() => ({
  activeId: "a0000000-0000-4000-8000-000000000001" as string | null,
}));

vi.mock("@/hooks/useActiveRestaurant", () => ({
  useActiveRestaurant: () => ({ activeRestaurantId: hookState.activeId }),
}));

vi.mock("@/lib/api", () => ({
  fetchVendorPendingBills: mocks.fetchVendorPendingBills,
  acknowledgeVendorBill: mocks.acknowledgeVendorBill,
  deliverVendorBill: mocks.deliverVendorBill,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("framer-motion", () => ({
  m: {
    li: ({ children }: { children?: ReactNode }) => <li>{children}</li>,
  },
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

function billRow(
  overrides: Partial<VendorPendingBillRow> & {
    billId?: string;
    requestStatus?: "PENDING" | "ACKNOWLEDGED";
    tableLabel?: string;
    total?: number;
  },
): VendorPendingBillRow {
  const billId = overrides.billId ?? "bill-0000-0000-0000-000000000001";
  const status = overrides.requestStatus ?? "PENDING";
  const label = overrides.tableLabel ?? "T1";
  return {
    bill: {
      id: billId,
      session_id: "session-0000-0000-0000-000000000001",
      restaurant_id: REST_A,
      food_subtotal: 200,
      packaging_fee: 0,
      gst_food: 18,
      gst_packaging: 0,
      total_amount: overrides.total ?? 236,
      frozen_at: "2026-09-04T05:31:00.000Z",
    },
    session: {
      id: "session-0000-0000-0000-000000000001",
      status: "BILL_REQUESTED",
      bill_requested_at: "2026-09-04T05:30:00.000Z",
      opened_at: "2026-09-04T05:00:00.000Z",
    },
    table: { id: "table-0000-0000-0000-000000000001", label },
    bring_bill_request: { id: `req-${billId}`, status },
  };
}

function apiError(code: string, message: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
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

function rowItem(tableLabel: string): HTMLElement {
  const item = screen
    .getAllByRole("listitem")
    .find((el) => within(el).queryByText(tableLabel) !== null);
  if (!item) throw new Error(`No bill row for table ${tableLabel}`);
  return item;
}

beforeEach(() => {
  hookState.activeId = REST_A;
  mocks.fetchVendorPendingBills.mockReset().mockResolvedValue([]);
  mocks.acknowledgeVendorBill.mockReset().mockResolvedValue({});
  mocks.deliverVendorBill.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe("Vendor bill queue page", () => {
  it("renders the server-ordered queue with the legal action per status", async () => {
    // Server order is bill_requested_at ASC then id ASC and is preserved as-is;
    // the second row alphabetically-precedes the first to prove no client sort.
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T2", total: 236 }),
      billRow({ billId: "bill-...0002", requestStatus: "ACKNOWLEDGED", tableLabel: "T1", total: 424 }),
    ]);

    render(<VendorBillsPage />);

    expect(await screen.findByText("T2")).toBeDefined();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("T2")).toBeDefined();
    expect(within(items[1]!).getByText("T1")).toBeDefined();
    expect(screen.getByText("Pending")).toBeDefined();
    expect(screen.getByText("Acknowledged")).toBeDefined();
    // Frozen totals are shown verbatim, never recomputed.
    expect(within(items[0]!).getByText(formatINR(236))).toBeDefined();
    expect(within(items[1]!).getByText(formatINR(424))).toBeDefined();
    // PENDING is acknowledged; ACKNOWLEDGED is delivered. Both link to detail.
    const pendingRow = rowItem("T2");
    const ackRow = rowItem("T1");
    expect(within(pendingRow).getByRole("button", { name: "Acknowledge" })).toBeDefined();
    expect(within(pendingRow).queryByRole("button", { name: "Mark delivered" })).toBeNull();
    expect(within(ackRow).getByRole("button", { name: "Mark delivered" })).toBeDefined();
    expect(within(ackRow).queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(within(pendingRow).getAllByRole("link", { name: "View bill" })).toHaveLength(1);
    expect(within(ackRow).getAllByRole("link", { name: "View bill" })).toHaveLength(1);
  });

  it("shows an independent empty state when there are no bill requests", async () => {
    render(<VendorBillsPage />);

    expect(await screen.findByText("No bill requests")).toBeDefined();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark delivered" })).toBeNull();
  });

  it("fetches for the active restaurant id", async () => {
    render(<VendorBillsPage />);

    expect(await screen.findByText("No bill requests")).toBeDefined();
    expect(mocks.fetchVendorPendingBills).toHaveBeenCalledWith(REST_A);
  });

  it("acknowledges a PENDING bill in place (patches status, keeps row)", async () => {
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
    ]);

    render(<VendorBillsPage />);
    await screen.findByText("T1");

    const row = rowItem("T1");
    const ackButton = await within(row).findByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButton);

    await waitFor(() =>
      expect(mocks.acknowledgeVendorBill).toHaveBeenCalledWith("bill-...0001"),
    );
    const updated = rowItem("T1");
    expect(within(updated).getByText("Acknowledged")).toBeDefined();
    expect(within(updated).queryByText("Pending")).toBeNull();
    expect(within(updated).getByRole("button", { name: "Mark delivered" })).toBeDefined();
  });

  it("delivers an ACKNOWLEDGED bill by removing it from the queue", async () => {
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0001", requestStatus: "ACKNOWLEDGED", tableLabel: "T1", total: 236 }),
      billRow({ billId: "bill-...0002", requestStatus: "PENDING", tableLabel: "T2", total: 424 }),
    ]);

    render(<VendorBillsPage />);
    await screen.findByText("T1");

    const row = rowItem("T1");
    const deliverButton = await within(row).findByRole("button", { name: "Mark delivered" });
    fireEvent.click(deliverButton);

    await waitFor(() =>
      expect(mocks.deliverVendorBill).toHaveBeenCalledWith("bill-...0001"),
    );
    expect(screen.queryByText("T1")).toBeNull();
    // The unrelated PENDING row survives and is still actionable.
    const survivor = rowItem("T2");
    expect(within(survivor).getByRole("button", { name: "Acknowledge" })).toBeDefined();
  });

  it("maps a stale-transition mutation error to refresh copy and reconciles", async () => {
    let resolveReconcile: (value: VendorPendingBillRow[]) => void = () => {};
    mocks.fetchVendorPendingBills
      .mockResolvedValueOnce([
        billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
      ])
      .mockImplementationOnce(
        () =>
          new Promise<VendorPendingBillRow[]>((resolve) => {
            resolveReconcile = resolve;
          }),
      );
    mocks.acknowledgeVendorBill.mockRejectedValueOnce(
      apiError(
        "INVALID_SERVICE_REQUEST_TRANSITION",
        "Bill cannot be acknowledged in its current status",
      ),
    );

    render(<VendorBillsPage />);
    await screen.findByText("T1");

    const row = rowItem("T1");
    const ackButton = await within(row).findByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButton);

    // While the reconcile is in flight the refresh copy is visible.
    expect(await screen.findByText(/already handled elsewhere/)).toBeDefined();
    await waitFor(() => expect(mocks.fetchVendorPendingBills).toHaveBeenCalledTimes(2));

    // The reconcile succeeds: the queue reflects the server's PENDING row and
    // the stale error copy clears (no invented state, no lingering banner).
    resolveReconcile([
      billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
    ]);
    await waitFor(() => expect(screen.queryByText(/already handled elsewhere/)).toBeNull());
    const reconciled = rowItem("T1");
    expect(within(reconciled).getByText("Pending")).toBeDefined();
    expect(within(reconciled).getByRole("button", { name: "Acknowledge" })).toBeDefined();
  });

  it("maps a vanished-bill mutation error to refresh copy and reconciles", async () => {
    let resolveReconcile: (value: VendorPendingBillRow[]) => void = () => {};
    mocks.fetchVendorPendingBills
      .mockResolvedValueOnce([
        billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
      ])
      .mockImplementationOnce(
        () =>
          new Promise<VendorPendingBillRow[]>((resolve) => {
            resolveReconcile = resolve;
          }),
      );
    mocks.deliverVendorBill.mockRejectedValueOnce(
      apiError("BILL_NOT_FOUND", "Bill not found"),
    );

    render(<VendorBillsPage />);
    await screen.findByText("T1");

    // Flip the row to ACKNOWLEDGED first so the deliver action exists.
    const row = rowItem("T1");
    const ackButton = await within(row).findByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButton);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull());

    const updated = rowItem("T1");
    fireEvent.click(within(updated).getByRole("button", { name: "Mark delivered" }));

    expect(await screen.findByText(/no longer available/)).toBeDefined();
    await waitFor(() => expect(mocks.fetchVendorPendingBills).toHaveBeenCalledTimes(2));

    // The reconcile confirms the bill is gone from the server: the queue shows
    // the honest empty state and the stale error copy clears.
    resolveReconcile([]);
    await waitFor(() => expect(screen.queryByText(/no longer available/)).toBeNull());
    expect(await screen.findByText("No bill requests")).toBeDefined();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("disables the row action and blocks a second click while the mutation is in flight", async () => {
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
      billRow({ billId: "bill-...0002", requestStatus: "ACKNOWLEDGED", tableLabel: "T2", total: 424 }),
    ]);

    let resolveAck: (value: object) => void = () => {};
    mocks.acknowledgeVendorBill.mockImplementationOnce(
      () =>
        new Promise<object>((resolve) => {
          resolveAck = resolve;
        }),
    );

    render(<VendorBillsPage />);
    await screen.findByText("T1");

    const row = rowItem("T1");
    const ackButton = await within(row).findByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButton);
    fireEvent.click(ackButton);

    const busyButton = await within(row).findByRole("button", { name: "Acknowledging..." });
    expect((busyButton as HTMLButtonElement).disabled).toBe(true);
    // Exactly one mutation was attempted despite the double click.
    expect(mocks.acknowledgeVendorBill).toHaveBeenCalledTimes(1);
    // Another row's action is unaffected by the in-flight mutation.
    const other = rowItem("T2");
    expect((within(other).getByRole("button", { name: "Mark delivered" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    resolveAck({});
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Acknowledging..." })).toBeNull(),
    );
    expect(within(rowItem("T1")).getByRole("button", { name: "Mark delivered" })).toBeDefined();
  });

  it("keeps an acknowledged row acknowledged when a stale poll still reports PENDING", async () => {
    vi.useFakeTimers();
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
    ]);
    mocks.acknowledgeVendorBill.mockResolvedValue({});

    render(<VendorBillsPage />);
    await flush();
    await flush();

    const row = rowItem("T1");
    fireEvent.click(within(row).getByRole("button", { name: "Acknowledge" }));
    await flush();

    expect(mocks.acknowledgeVendorBill).toHaveBeenCalledWith("bill-...0001");
    expect(within(rowItem("T1")).getByText("Acknowledged")).toBeDefined();

    // A poll snapshot taken before the acknowledge commit still reports PENDING;
    // the local patch must not regress.
    await tick(POLL_MS);
    expect(within(rowItem("T1")).getByText("Acknowledged")).toBeDefined();
    expect(within(rowItem("T1")).queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(within(rowItem("T1")).getByRole("button", { name: "Mark delivered" })).toBeDefined();
  });

  it("does not resurrect a delivered bill from a stale poll snapshot", async () => {
    vi.useFakeTimers();
    // Every poll keeps returning the row (snapshots taken pre-commit).
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0001", requestStatus: "ACKNOWLEDGED", tableLabel: "T1", total: 236 }),
    ]);
    mocks.deliverVendorBill.mockResolvedValue({});

    render(<VendorBillsPage />);
    await flush();
    await flush();

    const row = rowItem("T1");
    fireEvent.click(within(row).getByRole("button", { name: "Mark delivered" }));
    await flush();

    expect(mocks.deliverVendorBill).toHaveBeenCalledWith("bill-...0001");
    expect(screen.queryByText("T1")).toBeNull();

    // The stale poll must not bring the delivered row back as actionable.
    await tick(POLL_MS);
    expect(screen.queryByText("T1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark delivered" })).toBeNull();

    // Once the server stops returning the row the suppression releases, and an
    // unrelated later request renders normally.
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0002", requestStatus: "PENDING", tableLabel: "T2", total: 424 }),
    ]);
    await tick(POLL_MS);
    expect(within(rowItem("T2")).getByRole("button", { name: "Acknowledge" })).toBeDefined();
  });

  it("keeps showing stale rows with an error banner when a later poll fails", async () => {
    vi.useFakeTimers();
    mocks.fetchVendorPendingBills
      .mockResolvedValueOnce([
        billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
      ])
      .mockRejectedValueOnce(new Error("network down"));

    render(<VendorBillsPage />);
    await flush();
    await flush();
    expect(screen.getByText("T1")).toBeDefined();

    await tick(POLL_MS);
    expect(screen.getByText("T1")).toBeDefined();
    expect(screen.getByText("network down")).toBeDefined();
    // A subsequent successful poll clears the banner and keeps the row.
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0002", requestStatus: "PENDING", tableLabel: "T2", total: 424 }),
    ]);
    await tick(POLL_MS);
    expect(screen.queryByText("network down")).toBeNull();
    expect(screen.getByText("T2")).toBeDefined();
  });

  it("discards a superseded slow poll so the latest snapshot always wins", async () => {
    vi.useFakeTimers();
    // The first queue fetch is slow and returns a STALE pre-scan snapshot; the
    // next scheduled poll returns a newer snapshot first. The late first
    // response must never clobber the newer one (latest load wins).
    let resolveFirst: (value: VendorPendingBillRow[]) => void = () => {};
    mocks.fetchVendorPendingBills
      .mockImplementationOnce(
        () =>
          new Promise<VendorPendingBillRow[]>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue([
        billRow({ billId: "bill-...0002", requestStatus: "PENDING", tableLabel: "T2", total: 424 }),
      ]);

    render(<VendorBillsPage />);
    await flush();

    // The poll fires and its newer snapshot applies while the first is pending.
    await tick(POLL_MS);
    expect(within(rowItem("T2")).getByRole("button", { name: "Acknowledge" })).toBeDefined();

    // The superseded first response (older snapshot) resolves late: dropped.
    resolveFirst([
      billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
    ]);
    await flush();
    expect(screen.queryByText("T1")).toBeNull();
    expect(within(rowItem("T2")).getByRole("button", { name: "Acknowledge" })).toBeDefined();
    expect(mocks.fetchVendorPendingBills).toHaveBeenCalledTimes(2);
  });

  it("switches restaurants atomically and discards a stale prior fetch", async () => {
    let resolveFirst: (value: VendorPendingBillRow[]) => void = () => {};
    mocks.fetchVendorPendingBills.mockImplementationOnce(
      () =>
        new Promise<VendorPendingBillRow[]>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { rerender } = render(<VendorBillsPage />);
    await flush();
    expect(mocks.fetchVendorPendingBills).toHaveBeenLastCalledWith(REST_A);

    // The waiter switches restaurants while the first fetch is still pending.
    hookState.activeId = REST_B;
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0002", requestStatus: "PENDING", tableLabel: "T2", total: 424 }),
    ]);
    rerender(<VendorBillsPage />);
    await flush();

    expect(mocks.fetchVendorPendingBills).toHaveBeenLastCalledWith(REST_B);
    expect(await screen.findByText("T2")).toBeDefined();

    // The stale REST_A response resolves afterwards and must be discarded.
    resolveFirst([
      billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
    ]);
    await flush();
    expect(screen.queryByText("T1")).toBeNull();
    expect(screen.getByText("T2")).toBeDefined();
  });

  it("exposes only acknowledge/deliver actions and never payment or settle semantics", async () => {
    mocks.fetchVendorPendingBills.mockResolvedValue([
      billRow({ billId: "bill-...0001", requestStatus: "PENDING", tableLabel: "T1", total: 236 }),
      billRow({ billId: "bill-...0002", requestStatus: "ACKNOWLEDGED", tableLabel: "T2", total: 424 }),
    ]);

    render(<VendorBillsPage />);

    expect(await screen.findByText("T1")).toBeDefined();
    const body = document.body.textContent ?? "";
    for (const forbidden of [
      "Settle",
      "settle",
      "Paid",
      "Pay now",
      "Close session",
      "Cancel",
      "Payment",
      "owner",
      "requested_by",
      "table_token",
    ]) {
      expect(body).not.toContain(forbidden);
    }
    expect(screen.queryByRole("button", { name: /settle|pay|close|cancel/i })).toBeNull();
  });

  it("links back to the existing dine-in surfaces from the page header", async () => {
    render(<VendorBillsPage />);

    await screen.findByRole("heading", { name: "Bill Requests" });
    const ordersLink = screen.getByRole("link", { name: "Orders & requests" });
    const tablesLink = screen.getByRole("link", { name: "Table board" });
    expect(ordersLink.getAttribute("href")).toBe("/dine-in");
    expect(tablesLink.getAttribute("href")).toBe("/dine-in/tables");
  });
});
