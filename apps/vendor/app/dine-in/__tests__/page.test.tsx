import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DineInPage from "../page";
import type { ServiceRequestMutationResult, VendorServiceRequest } from "@/lib/api";

const REST_ID = "a0000000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  fetchDineInOrders: vi.fn(),
  advanceDineInOrder: vi.fn(),
  cancelDineInOrder: vi.fn(),
  fetchDineInServiceRequests: vi.fn(),
  acknowledgeDineInServiceRequest: vi.fn(),
  completeDineInServiceRequest: vi.fn(),
}));

vi.mock("@/hooks/useActiveRestaurant", () => ({
  useActiveRestaurant: () => ({
    activeRestaurantId: "a0000000-0000-4000-8000-000000000001",
  }),
}));

vi.mock("@/lib/api", () => ({
  fetchDineInOrders: mocks.fetchDineInOrders,
  advanceDineInOrder: mocks.advanceDineInOrder,
  cancelDineInOrder: mocks.cancelDineInOrder,
  fetchDineInServiceRequests: mocks.fetchDineInServiceRequests,
  acknowledgeDineInServiceRequest: mocks.acknowledgeDineInServiceRequest,
  completeDineInServiceRequest: mocks.completeDineInServiceRequest,
}));

vi.mock("framer-motion", () => ({
  m: {
    li: ({ children }: { children?: ReactNode }) => <li>{children}</li>,
  },
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

function requestRow(overrides: Partial<VendorServiceRequest>): VendorServiceRequest {
  return {
    id: "req-1",
    session_id: "s1",
    restaurant_id: REST_ID,
    request_type: "WATER",
    status: "PENDING",
    note: null,
    created_at: "2026-09-04T05:00:00.000Z",
    table: { id: "t1", label: "T1" },
    ...overrides,
  };
}

function ackResult(
  overrides: Partial<ServiceRequestMutationResult["request"]> = {},
): ServiceRequestMutationResult {
  return {
    request: {
      id: "req-1",
      session_id: "s1",
      restaurant_id: REST_ID,
      request_type: "WATER",
      status: "ACKNOWLEDGED",
      note: null,
      acknowledged_by: "staff-1",
      acknowledged_at: "2026-09-04T05:02:00.000Z",
      completed_by: null,
      completed_at: null,
      cancelled_by: null,
      cancelled_at: null,
      created_at: "2026-09-04T05:00:00.000Z",
      updated_at: "2026-09-04T05:02:00.000Z",
      ...overrides,
    },
  };
}

function apiError(code: string, message: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

// The dine-in page polls on a single 15s interval. These tests run under
// vi.useFakeTimers() so the overlap window between a mutation commit and a poll
// snapshot taken before that commit can be exercised deterministically.
const POLL_MS = 15_000;

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// RTL waitFor/findBy poll on real timers and hang under vi.useFakeTimers(), so
// these tests flush microtasks explicitly and use getBy/queryBy assertions.
async function flush() {
  await act(async () => {});
}

beforeEach(() => {
  mocks.fetchDineInOrders.mockReset().mockResolvedValue([]);
  mocks.advanceDineInOrder
    .mockReset()
    .mockResolvedValue({ order: { id: "o", status: "PREPARING" } });
  mocks.cancelDineInOrder
    .mockReset()
    .mockResolvedValue({ order: { id: "o", status: "CANCELLED" } });
  mocks.fetchDineInServiceRequests.mockReset().mockResolvedValue([]);
  mocks.acknowledgeDineInServiceRequest.mockReset().mockResolvedValue(ackResult());
  mocks.completeDineInServiceRequest
    .mockReset()
    .mockResolvedValue(ackResult({ id: "req-2", status: "COMPLETED" }));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe("Dine-In page service-request strip", () => {
  it("renders actionable queue rows with the legal action per status", async () => {
    mocks.fetchDineInServiceRequests.mockResolvedValue([
      requestRow({ id: "req-1", request_type: "WATER", status: "PENDING" }),
      requestRow({
        id: "req-2",
        request_type: "CUTLERY",
        status: "ACKNOWLEDGED",
        table: { id: "t2", label: "T2" },
      }),
      requestRow({
        id: "req-3",
        request_type: "OTHER",
        status: "PENDING",
        note: "refill please",
        table: { id: "t3", label: "T3" },
      }),
    ]);

    render(<DineInPage />);

    expect(await screen.findByText("T1")).toBeDefined();
    expect(screen.getByText("Water")).toBeDefined();
    expect(screen.getAllByText("Pending")).toHaveLength(2);
    expect(screen.getByText("Acknowledged")).toBeDefined();
    expect(screen.getByText("T2")).toBeDefined();
    expect(screen.getByText("Cutlery")).toBeDefined();
    // OTHER note is shown for staff to read.
    expect(screen.getByText(/refill please/)).toBeDefined();
    // Only PENDING has an Acknowledge action; ACKNOWLEDGED has Mark Complete.
    expect(screen.getAllByRole("button", { name: "Acknowledge" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Mark Complete" })).toHaveLength(1);
  });

  it("acknowledges a PENDING row in place (patches status, keeps row)", async () => {
    mocks.fetchDineInServiceRequests.mockResolvedValue([
      requestRow({ id: "req-1", request_type: "WATER", status: "PENDING" }),
    ]);
    mocks.acknowledgeDineInServiceRequest.mockResolvedValue(
      ackResult({ id: "req-1", status: "ACKNOWLEDGED" }),
    );

    render(<DineInPage />);

    const ackButton = await screen.findByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButton);

    await waitFor(() =>
      expect(mocks.acknowledgeDineInServiceRequest).toHaveBeenCalledWith("req-1"),
    );
    // Row stays, now rendered as acknowledged with a complete action.
    expect(await screen.findByText("T1")).toBeDefined();
    expect(screen.getByText("Acknowledged")).toBeDefined();
    expect(screen.queryByText("Pending")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Mark Complete" })).toHaveLength(1);
  });

  it("completes an ACKNOWLEDGED row by removing it from the board", async () => {
    mocks.fetchDineInServiceRequests.mockResolvedValue([
      requestRow({ id: "req-1", request_type: "WATER", status: "ACKNOWLEDGED" }),
      requestRow({
        id: "req-2",
        request_type: "CUTLERY",
        status: "PENDING",
        table: { id: "t2", label: "T2" },
      }),
    ]);

    render(<DineInPage />);

    const completeButton = await screen.findByRole("button", {
      name: "Mark Complete",
    });
    fireEvent.click(completeButton);

    await waitFor(() => expect(mocks.completeDineInServiceRequest).toHaveBeenCalledWith("req-1"));
    await waitFor(() => expect(screen.queryByText("T1")).toBeNull());
    // The unrelated PENDING row survives.
    expect(screen.getByText("T2")).toBeDefined();
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeDefined();
  });

  it("shows an independent empty state when there are no requests", async () => {
    mocks.fetchDineInOrders.mockResolvedValue([]);
    mocks.fetchDineInServiceRequests.mockResolvedValue([]);

    render(<DineInPage />);

    expect(await screen.findByText("No service requests")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark Complete" })).toBeNull();
  });

  it("maps a stale-transition mutation error to refresh copy", async () => {
    mocks.fetchDineInServiceRequests.mockResolvedValue([
      requestRow({ id: "req-1", request_type: "WATER", status: "PENDING" }),
    ]);
    mocks.acknowledgeDineInServiceRequest.mockRejectedValueOnce(
      apiError(
        "INVALID_SERVICE_REQUEST_TRANSITION",
        "Service request cannot be acknowledged in its current status",
      ),
    );

    render(<DineInPage />);

    const ackButton = await screen.findByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButton);

    expect(await screen.findByText(/already updated elsewhere/)).toBeDefined();
  });

  it("disables the row action while the mutation is in flight", async () => {
    mocks.fetchDineInServiceRequests.mockResolvedValue([
      requestRow({ id: "req-1", request_type: "WATER", status: "PENDING" }),
    ]);

    let resolveAck: (value: ServiceRequestMutationResult) => void = () => {};
    mocks.acknowledgeDineInServiceRequest.mockImplementationOnce(
      () =>
        new Promise<ServiceRequestMutationResult>((resolve) => {
          resolveAck = resolve;
        }),
    );

    render(<DineInPage />);

    const ackButton = await screen.findByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButton);

    const busyButton = await screen.findByRole("button", {
      name: "Acknowledging...",
    });
    expect((busyButton as HTMLButtonElement).disabled).toBe(true);

    resolveAck(ackResult({ id: "req-1", status: "ACKNOWLEDGED" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Acknowledging..." })).toBeNull(),
    );
  });

  it("defensively suppresses a BRING_BILL row even if the server sent one", async () => {
    mocks.fetchDineInServiceRequests.mockResolvedValue([
      requestRow({ id: "req-1", request_type: "WATER", status: "PENDING" }),
      requestRow({
        id: "req-bill",
        request_type: "BRING_BILL",
        status: "PENDING",
        table: { id: "t9", label: "T9" },
      }),
    ]);

    render(<DineInPage />);

    expect(await screen.findByText("T1")).toBeDefined();
    expect(screen.queryByText("Bring bill")).toBeNull();
    expect(screen.queryByText("T9")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Acknowledge" })).toHaveLength(1);
  });

  it("does not resurrect a completed row from a stale poll snapshot", async () => {
    vi.useFakeTimers();
    // Every poll returns the ACKNOWLEDGED row, i.e. polls whose snapshot was
    // taken before the complete mutation's commit keep containing the row.
    mocks.fetchDineInOrders.mockResolvedValue([]);
    mocks.fetchDineInServiceRequests.mockResolvedValue([
      requestRow({ id: "req-1", request_type: "WATER", status: "ACKNOWLEDGED" }),
    ]);
    mocks.completeDineInServiceRequest.mockResolvedValue(
      ackResult({ id: "req-1", status: "COMPLETED" }),
    );

    render(<DineInPage />);
    await flush();
    await flush();

    const completeButton = screen.getByRole("button", {
      name: "Mark Complete",
    });
    fireEvent.click(completeButton);
    await flush();

    expect(mocks.completeDineInServiceRequest).toHaveBeenCalledWith("req-1");
    expect(screen.queryByText("T1")).toBeNull();

    // The next poll resolves with a snapshot that still contains the row. The
    // completed id must stay suppressed instead of flashing back as actionable.
    await tick(POLL_MS);
    expect(screen.queryByText("T1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark Complete" })).toBeNull();

    // Once the server stops returning the row the suppression is released and
    // an unrelated request that arrives later renders normally.
    mocks.fetchDineInServiceRequests.mockResolvedValue([
      requestRow({
        id: "req-2",
        request_type: "CUTLERY",
        status: "PENDING",
        table: { id: "t2", label: "T2" },
      }),
    ]);
    await tick(POLL_MS);
    expect(screen.getByText("T2")).toBeDefined();
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeDefined();
  });

  it("keeps an acknowledged row acknowledged when a stale poll still reports PENDING", async () => {
    vi.useFakeTimers();
    // Polls keep reporting the row as PENDING even after the acknowledge commit.
    mocks.fetchDineInOrders.mockResolvedValue([]);
    mocks.fetchDineInServiceRequests.mockResolvedValue([
      requestRow({ id: "req-1", request_type: "WATER", status: "PENDING" }),
    ]);
    mocks.acknowledgeDineInServiceRequest.mockResolvedValue(
      ackResult({ id: "req-1", status: "ACKNOWLEDGED" }),
    );

    render(<DineInPage />);
    await flush();
    await flush();

    const ackButton = screen.getByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButton);
    await flush();

    expect(mocks.acknowledgeDineInServiceRequest).toHaveBeenCalledWith("req-1");
    expect(screen.getByText("Acknowledged")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();

    // A snapshot taken before the acknowledge commit resolves afterwards and
    // still reports PENDING; the local ACKNOWLEDGED patch must not regress.
    await tick(POLL_MS);
    expect(screen.getByText("Acknowledged")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark Complete" })).toBeDefined();
  });
});
