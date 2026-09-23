import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrderTracker } from "../OrderTracker";

const wsMock = vi.hoisted(() => ({
  status: null as string | null,
  connected: false,
}));

vi.mock("@/hooks/useWebSocket", () => ({
  useWebSocket: () => ({ status: wsMock.status, connected: wsMock.connected }),
}));

vi.mock("@/components/FeatureFlagProvider", () => ({
  useFeatureFlags: () => ({ isEnabled: () => false }),
}));

beforeEach(() => {
  wsMock.status = null;
  wsMock.connected = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("OrderTracker status notification", () => {
  it("does not notify on initial render", () => {
    const onStatusChange = vi.fn();
    render(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("notifies once on a genuine WebSocket status change", () => {
    const onStatusChange = vi.fn();
    const { rerender } = render(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    wsMock.status = "PREPARING";
    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("PREPARING");
  });

  it("suppresses duplicate notifications for the same status", () => {
    const onStatusChange = vi.fn();
    const { rerender } = render(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    wsMock.status = "PREPARING";
    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    // Same status value again: no new notification even on a fresh render.
    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });

  it("does not notify while the live status is null", () => {
    const onStatusChange = vi.fn();
    wsMock.status = null;
    const { rerender } = render(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="PREPARING"
        onStatusChange={onStatusChange}
      />,
    );

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("keeps a previous order's status from notifying the new order", () => {
    const onStatusChange = vi.fn();
    const { rerender } = render(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    wsMock.status = "PREPARING";
    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    // Order id changes while the stale PREPARING status is still held: the new
    // order must not receive the previous order's status.
    rerender(
      <OrderTracker
        orderId="o2"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    // The new order's own genuine status does notify.
    wsMock.status = "READY_FOR_PICKUP";
    rerender(
      <OrderTracker
        orderId="o2"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    expect(onStatusChange).toHaveBeenLastCalledWith("READY_FOR_PICKUP");
  });

  it("does not re-notify a retained previous-order status on a later rerender", () => {
    const onStatusChange = vi.fn();
    const { rerender } = render(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    wsMock.status = "PREPARING";
    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenLastCalledWith("PREPARING");

    // The hook keeps the previous order's PREPARING status after the order id
    // changes. The transition to o2 itself must not notify.
    rerender(
      <OrderTracker
        orderId="o2"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    // A later unrelated rerender with the same retained stale status must also
    // not notify; this is the case the order-change-only guard missed.
    rerender(
      <OrderTracker
        orderId="o2"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    // The new order's first genuine transition notifies exactly once.
    wsMock.status = "READY_FOR_PICKUP";
    rerender(
      <OrderTracker
        orderId="o2"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    expect(onStatusChange).toHaveBeenLastCalledWith("READY_FOR_PICKUP");
  });

  it("renders the live status in the timeline without a callback", () => {
    wsMock.status = "ALMOST_READY";
    wsMock.connected = true;
    render(<OrderTracker orderId="o1" initialStatus="CONFIRMED" />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Almost Ready")).toBeInTheDocument();
  });

  it("renders an explicit terminal panel for an initial CANCELLED status", () => {
    render(<OrderTracker orderId="o1" initialStatus="CANCELLED" />);
    expect(screen.getByText("Order Cancelled")).toBeInTheDocument();
    expect(
      screen.getByText("This order has been cancelled."),
    ).toBeInTheDocument();
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
    // Connection indicator is preserved alongside the terminal panel.
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("renders an explicit terminal panel for an initial PAYMENT_FAILED status", () => {
    render(<OrderTracker orderId="o1" initialStatus="PAYMENT_FAILED" />);
    expect(screen.getByText("Payment Failed")).toBeInTheDocument();
    expect(
      screen.getByText("Payment could not be completed for this order."),
    ).toBeInTheDocument();
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
  });

  it("does not render the normal progress timeline for a terminal status", () => {
    render(<OrderTracker orderId="o1" initialStatus="CANCELLED" />);
    expect(screen.queryByText("Confirmed")).not.toBeInTheDocument();
    expect(screen.queryByText("Preparing")).not.toBeInTheDocument();
    expect(screen.queryByText("Almost Ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Picked Up")).not.toBeInTheDocument();
  });

  it("shows terminal UI and notifies once when the live status becomes CANCELLED", () => {
    const onStatusChange = vi.fn();
    const { rerender } = render(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    wsMock.status = "CANCELLED";
    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    expect(screen.getByText("Order Cancelled")).toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("CANCELLED");
  });

  it("shows terminal UI and notifies once when the live status becomes PAYMENT_FAILED", () => {
    const onStatusChange = vi.fn();
    const { rerender } = render(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    wsMock.status = "PAYMENT_FAILED";
    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    expect(screen.getByText("Payment Failed")).toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("PAYMENT_FAILED");
  });

  it("does not notify twice for a duplicate terminal status", () => {
    const onStatusChange = vi.fn();
    const { rerender } = render(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    wsMock.status = "CANCELLED";
    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );
    rerender(
      <OrderTracker
        orderId="o1"
        initialStatus="CONFIRMED"
        onStatusChange={onStatusChange}
      />,
    );

    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the normal timeline and progress affordance for PREPARING", () => {
    wsMock.status = "PREPARING";
    wsMock.connected = true;
    render(<OrderTracker orderId="o1" initialStatus="CONFIRMED" />);
    expect(screen.getByText("Preparing")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.queryByText("Order Cancelled")).not.toBeInTheDocument();
    expect(screen.queryByText("Payment Failed")).not.toBeInTheDocument();
  });

  it("keeps the PICKED_UP timeline state without a terminal panel", () => {
    render(<OrderTracker orderId="o1" initialStatus="PICKED_UP" />);
    expect(screen.getByText("Picked Up")).toBeInTheDocument();
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
    expect(screen.queryByText("Order Cancelled")).not.toBeInTheDocument();
    expect(screen.queryByText("Payment Failed")).not.toBeInTheDocument();
  });
});
