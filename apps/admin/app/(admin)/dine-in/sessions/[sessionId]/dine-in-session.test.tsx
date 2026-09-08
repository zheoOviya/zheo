// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DineInSessionDetailPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ sessionId: "s0000000-0000-4000-8000-000000000001" }),
}));

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  fetchAdminDineInSessionDetail: vi.fn(),
}));

vi.mock("../../../../../lib/api", () => mocks);

const DETAIL = {
  session: {
    session_id: "s0000000-0000-4000-8000-000000000001",
    status: "ACTIVE",
    opened_at: "2026-09-07T09:00:00.000Z",
    updated_at: "2026-09-07T09:40:00.000Z",
    bill_requested_at: "2026-09-07T09:30:00.000Z",
    payment_pending_at: null,
  },
  restaurant: {
    restaurant_id: "r0000000-0000-4000-8000-000000000001",
    restaurant_name: "Biryani House",
  },
  table: { table_id: "t1", table_label: "T-12", seat_count: 4 },
  zone: { zone_id: "z1", zone_name: "Garden" },
  orders: [
    {
      id: "o0000000-0000-4000-8000-000000000001",
      status: "SERVED",
      total_amount: 450,
      created_at: "2026-09-07T09:10:00.000Z",
      items: [
        { name: "Butter Chicken", quantity: 1, item_subtotal: 380 },
        { name: "Naan", quantity: 2, item_subtotal: 70 },
      ],
    },
  ],
  service_requests: [
    {
      id: "sr000000-0000-4000-8000-000000000001",
      request_type: "WATER",
      status: "COMPLETED",
      note: null,
      created_at: "2026-09-07T09:12:00.000Z",
      acknowledged_at: "2026-09-07T09:14:00.000Z",
      completed_at: "2026-09-07T09:16:00.000Z",
      cancelled_at: null,
    },
  ],
  bill: {
    status: "ACKNOWLEDGED",
    requested_at: "2026-09-07T09:30:00.000Z",
    acknowledged_at: "2026-09-07T09:32:00.000Z",
    delivered_at: null,
    totals: {
      food_subtotal: 450,
      packaging_fee: 10,
      gst_food: 23.6,
      gst_packaging: 1.2,
      total_amount: 484.8,
      frozen_at: "2026-09-07T09:31:00.000Z",
    },
  },
};

describe("Admin dine-in session detail page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAdminDineInSessionDetail.mockResolvedValue(DETAIL);
  });

  it("shows a loading skeleton before data arrives", () => {
    mocks.fetchAdminDineInSessionDetail.mockReturnValue(new Promise(() => {}));
    const { container } = render(<DineInSessionDetailPage />);
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    expect(screen.queryByText("Biryani House")).toBeNull();
  });

  it("renders context, orders, service requests, and bill state", async () => {
    render(<DineInSessionDetailPage />);
    expect(await screen.findByText("Biryani House")).toBeTruthy();
    expect(screen.getByText("T-12")).toBeTruthy();
    expect(screen.getByText("Garden")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Butter Chicken")).toBeTruthy();
    expect(screen.getByText("Naan")).toBeTruthy();
    expect(screen.getByText("Water")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Acknowledged")).toBeTruthy();
    expect(screen.getByText("Frozen bill totals")).toBeTruthy();
  });

  it("shows frozen bill totals and the session as bill requested", async () => {
    const d = {
      ...DETAIL,
      session: { ...DETAIL.session, status: "BILL_REQUESTED", bill_requested_at: "2026-09-07T09:30:00.000Z" },
      bill: {
        ...DETAIL.bill,
        status: "REQUESTED",
        acknowledged_at: null,
        totals: {
          food_subtotal: 450,
          packaging_fee: 10,
          gst_food: 23.6,
          gst_packaging: 1.2,
          total_amount: 484.8,
          frozen_at: "2026-09-07T09:31:00.000Z",
        },
      },
    };
    mocks.fetchAdminDineInSessionDetail.mockResolvedValue(d);
    render(<DineInSessionDetailPage />);
    expect(await screen.findByText("Bill requested")).toBeTruthy();
    expect(screen.getByText("Rs.484.8")).toBeTruthy();
  });

  it("renders an error banner when the API fails", async () => {
    mocks.fetchAdminDineInSessionDetail.mockRejectedValue(new Error("detail boom"));
    render(<DineInSessionDetailPage />);
    expect(await screen.findByText("detail boom")).toBeTruthy();
  });

  it("renders a 404 state for an unknown or closed session", async () => {
    mocks.fetchAdminDineInSessionDetail.mockRejectedValue(new Error("Dine-in session not found"));
    render(<DineInSessionDetailPage />);
    expect(await screen.findByText("Session not found")).toBeTruthy();
  });

  it("keeps last data and shows an error banner when a poll refresh fails", async () => {
    render(<DineInSessionDetailPage />);
    await screen.findByText("Biryani House");

    mocks.fetchAdminDineInSessionDetail.mockRejectedValueOnce(new Error("poll failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("poll failed")).toBeTruthy();
    expect(screen.getByText("Biryani House")).toBeTruthy();
  });

  it("links back to the dine-in oversight page", async () => {
    render(<DineInSessionDetailPage />);
    await screen.findByText("Biryani House");
    const link = screen.getByRole("link", { name: /Back to Dine-In Oversight/ });
    expect(link.getAttribute("href")).toBe("/dine-in");
  });

  it("exposes no payment/settlement/close/advance mutation controls", async () => {
    render(<DineInSessionDetailPage />);
    await screen.findByText("Biryani House");
    expect(
      screen.queryByRole("button", { name: /Settle|Pay|Close|Advance|Refund|Mark Paid/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Acknowledge|Deliver/i }),
    ).toBeNull();
  });
});
