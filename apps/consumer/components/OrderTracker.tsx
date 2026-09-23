"use client";

import { useEffect, useRef } from "react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useFeatureFlags } from "@/components/FeatureFlagProvider";

const STATUS_STEPS = [
  { key: "CONFIRMED", label: "Confirmed" },
  { key: "PREPARING", label: "Preparing" },
  { key: "ALMOST_READY", label: "Almost Ready" },
  { key: "READY_FOR_PICKUP", label: "Ready" },
  { key: "PICKED_UP", label: "Picked Up" },
];

const STATUS_ORDER = STATUS_STEPS.map((s) => s.key);

// Terminal statuses fall outside the linear progress chain: rendering them as
// an inactive five-step timeline misrepresents a cancelled/failed order as an
// order that is merely not started. They get an explicit terminal panel
// instead. Unknown statuses keep the existing (empty) timeline fallback.
const TERMINAL_PRESENTATION: Record<string, { title: string; copy: string }> = {
  CANCELLED: {
    title: "Order Cancelled",
    copy: "This order has been cancelled.",
  },
  PAYMENT_FAILED: {
    title: "Payment Failed",
    copy: "Payment could not be completed for this order.",
  },
};

interface OrderTrackerProps {
  orderId: string;
  initialStatus: string;
  onStatusChange?: (status: string) => void;
}

export function OrderTracker({ orderId, initialStatus, onStatusChange }: OrderTrackerProps) {
  const { status: liveStatus, connected } = useWebSocket(orderId);
  const currentStatus = liveStatus ?? initialStatus;
  const currentIdx = STATUS_ORDER.indexOf(currentStatus);
  const animated = useFeatureFlags().isEnabled("ab_animated_tracker");
  const motionClass = animated ? "transition-colors duration-500" : "";
  const terminal = TERMINAL_PRESENTATION[currentStatus];

  // Keep the latest callback without re-subscribing the notification effect.
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  // Presentation-only status notification: the tracker reports genuine live
  // status transitions upward but never fetches or writes parent state. The
  // hook does not reset its own status when the order id changes, so a new
  // order adopts whatever the hook currently reports as its baseline instead
  // of null; otherwise a retained status from the previous order would be
  // re-reported for the new order on the next render. The callback never fires
  // during render.
  const prevRef = useRef<{ orderId: string; status: string | null }>({
    orderId,
    status: liveStatus,
  });

  useEffect(() => {
    const prev = prevRef.current;
    const orderChanged = prev.orderId !== orderId;
    const statusChanged = prev.status !== liveStatus;
    // Always adopt the currently observed status as the baseline. On an order
    // change that suppresses a retained stale status without also swallowing
    // the new order's subsequent genuine transition.
    prevRef.current = { orderId, status: liveStatus };
    if (orderChanged) return;
    if (!statusChanged || liveStatus === null) return;
    onStatusChangeRef.current?.(liveStatus);
  }, [liveStatus, orderId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-neutral-300"}`} />
        <span className="text-xs text-neutral-400">{connected ? "Live" : "Connecting..."}</span>
      </div>

      {terminal ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-red-500/20 bg-red-500/10 p-4"
        >
          <p className="text-sm font-semibold text-red-700">{terminal.title}</p>
          <p className="mt-1 text-xs text-neutral-500">{terminal.copy}</p>
        </div>
      ) : (
      <div className="relative space-y-0">
        {STATUS_STEPS.map((step, idx) => {
          const isDone = idx <= currentIdx;
          const isCurrent = idx === currentIdx;

          return (
            <div key={step.key} className="flex items-start gap-4">
              {/* Timeline connector */}
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${motionClass} ${
                    isDone ? "bg-primary-500 text-white" : "bg-primary-500/10 text-primary-400"
                  } ${isCurrent ? "ring-4 ring-primary-500/30" : ""}`}
                >
                  {isDone && !isCurrent ? (
                    <CheckIcon className="h-4 w-4" />
                  ) : (
                    idx + 1
                  )}
                </div>
                {idx < STATUS_STEPS.length - 1 && (
                  <div
                    className={`mt-1 h-6 w-0.5 ${motionClass} ${
                      isDone ? "bg-primary-500" : "bg-primary-500/10"
                    }`}
                  />
                )}
              </div>

              <div className="flex-1 pb-6">
                <p
                  className={`text-sm font-semibold ${motionClass} ${
                    isCurrent
                      ? "text-primary-700"
                      : isDone
                        ? "text-neutral-600"
                        : "text-neutral-300"
                  }`}
                >
                  {step.label}
                </p>
                {isCurrent && currentStatus !== "PICKED_UP" && (
                  <div className="mt-1 flex items-center gap-1">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full bg-primary-500 ${
                        animated ? "animate-pulse" : ""
                      }`}
                    />
                    <span className="text-xs text-primary-500">In progress</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
