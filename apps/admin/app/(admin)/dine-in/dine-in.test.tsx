// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DineInOverviewPage from "./page";

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  fetchAdminDineInOverview: vi.fn(),
  fetchAdminDineInSessions: vi.fn(),
}));

vi.mock("../../../lib/api", () => mocks);

const OVERVIEW = {
  totals: {
    restaurants: 2,
    active_sessions: 3,
    bill_requested_sessions: 1,
    pending_service_requests: 2,
  },
  by_restaurant: [
    {
      restaurant_id: "r0000000-0000-4000-8000-000000000001",
      restaurant_name: "Biryani House",
      active_sessions: 2,
      bill_requested_sessions: 1,
      pending_service_requests: 1,
    },
    {
      restaurant_id: "r0000000-0000-4000-8000-000000000002",
      restaurant_name: "Pizza Hub",
      active_sessions: 1,
      bill_requested_sessions: 0,
      pending_service_requests: 1,
    },
  ],
  generated_at: "2026-09-07T10:00:00.000Z",
};

const LIST = {
  items: [
    {
      session_id: "s0000000-0000-4000-8000-000000000001",
      restaurant_id: "r0000000-0000-4000-8000-000000000001",
      restaurant_name: "Biryani House",
      table_id: "t0000000-0000-4000-8000-000000000001",
      table_label: "T-12",
      zone_name: "Garden",
      status: "ACTIVE",
      order_count: 2,
      pending_service_request_count: 1,
      bill_status: "NONE",
      opened_at: "2026-09-07T09:00:00.000Z",
      updated_at: "2026-09-07T09:40:00.000Z",
    },
    {
      session_id: "s0000000-0000-4000-8000-000000000002",
      restaurant_id: "r0000000-0000-4000-8000-000000000001",
      restaurant_name: "Biryani House",
      table_id: "t0000000-0000-4000-8000-000000000002",
      table_label: "T-14",
      zone_name: null,
      status: "BILL_REQUESTED",
      order_count: 1,
      pending_service_request_count: 0,
      bill_status: "REQUESTED",
      opened_at: "2026-09-07T08:30:00.000Z",
      updated_at: "2026-09-07T09:50:00.000Z",
    },
    {
      session_id: "s0000000-0000-4000-8000-000000000003",
      restaurant_id: "r0000000-0000-4000-8000-000000000002",
      restaurant_name: "Pizza Hub",
      table_id: "t0000000-0000-4000-8000-000000000003",
      table_label: "P-02",
      zone_name: "Patio",
      status: "PAYMENT_PENDING",
      order_count: 0,
      pending_service_request_count: 1,
      bill_status: "DELIVERED",
      opened_at: "2026-09-07T07:45:00.000Z",
      updated_at: "2026-09-07T09:55:00.000Z",
    },
  ],
  pagination: { page: 1, limit: 20, total: 3 },
};

describe("Admin dine-in overview page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAdminDineInOverview.mockResolvedValue(OVERVIEW);
    mocks.fetchAdminDineInSessions.mockResolvedValue(LIST);
  });

  it("shows a loading skeleton before data arrives", () => {
    mocks.fetchAdminDineInOverview.mockReturnValue(new Promise(() => {}));
    mocks.fetchAdminDineInSessions.mockReturnValue(new Promise(() => {}));
    const { container } = render(<DineInOverviewPage />);
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    expect(screen.queryByText("Active sessions")).toBeNull();
  });

  it("renders stat totals, by-restaurant summary, and session rows", async () => {
    render(<DineInOverviewPage />);
    expect(await screen.findByText("Active sessions")).toBeTruthy();
    expect(screen.getByText("Pending service requests")).toBeTruthy();
    expect(screen.getByText("Restaurants")).toBeTruthy();
    expect((await screen.findAllByText("Biryani House")).length).toBeGreaterThan(0);
    expect(screen.getByText("Garden")).toBeTruthy();
    expect(screen.getByText("Patio")).toBeTruthy();
    expect(screen.getAllByText("Payment pending").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Delivered").length).toBeGreaterThan(0);
  });

  it("renders an empty state when there are no live sessions", async () => {
    mocks.fetchAdminDineInOverview.mockResolvedValue({
      ...OVERVIEW,
      totals: { restaurants: 0, active_sessions: 0, bill_requested_sessions: 0, pending_service_requests: 0 },
      by_restaurant: [],
    });
    mocks.fetchAdminDineInSessions.mockResolvedValue({ items: [], pagination: { page: 1, limit: 20, total: 0 } });
    render(<DineInOverviewPage />);
    expect(await screen.findByText("No live dine-in sessions")).toBeTruthy();
  });

  it("shows an error banner when the API fails", async () => {
    mocks.fetchAdminDineInOverview.mockRejectedValue(new Error("overview boom"));
    mocks.fetchAdminDineInSessions.mockRejectedValue(new Error("list boom"));
    render(<DineInOverviewPage />);
    expect(await screen.findByText("overview boom")).toBeTruthy();
    expect(screen.getByText("list boom")).toBeTruthy();
  });

  it("refetches sessions with restaurant and status params and resets to page 1", async () => {
    const paged = { ...LIST, pagination: { page: 1, limit: 20, total: 40 } };
    mocks.fetchAdminDineInSessions.mockResolvedValue(paged);
    render(<DineInOverviewPage />);
    await screen.findByRole("button", { name: "Next" });

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(mocks.fetchAdminDineInSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
      ),
    );

    fireEvent.change(screen.getByLabelText("Filter by session status"), {
      target: { value: "BILL_REQUESTED" },
    });
    await waitFor(() =>
      expect(mocks.fetchAdminDineInSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "BILL_REQUESTED", page: 1 }),
      ),
    );

    fireEvent.change(screen.getByLabelText("Filter by restaurant"), {
      target: { value: "r0000000-0000-4000-8000-000000000002" },
    });
    await waitFor(() =>
      expect(mocks.fetchAdminDineInSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ restaurant_id: "r0000000-0000-4000-8000-000000000002", page: 1 }),
      ),
    );
  });

  it("links each session row to the detail page", async () => {
    render(<DineInOverviewPage />);
    const link = (await screen.findByText("T-12")).closest("a");
    expect(link?.getAttribute("href")).toBe("/dine-in/sessions/s0000000-0000-4000-8000-000000000001");
  });

  it("keeps last data and shows an error banner when a poll refresh fails", async () => {
    render(<DineInOverviewPage />);
    await screen.findByText("T-12");

    mocks.fetchAdminDineInOverview.mockRejectedValueOnce(new Error("poll failed"));
    mocks.fetchAdminDineInSessions.mockResolvedValueOnce(LIST);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("poll failed")).toBeTruthy();
    expect(screen.getByText("T-12")).toBeTruthy();
  });

  it("exposes no payment/settlement/close mutation controls", async () => {
    render(<DineInOverviewPage />);
    await screen.findByText("T-12");
    expect(
      screen.queryByRole("button", { name: /Settle|Pay|Close|Advance|Refund|Acknowledge|Deliver/i }),
    ).toBeNull();
    expect(screen.queryByText(/Mark Paid/i)).toBeNull();
  });
});
