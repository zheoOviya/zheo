"use client";

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

interface OrderTrackerProps {
  orderId: string;
  initialStatus: string;
}

export function OrderTracker({ orderId, initialStatus }: OrderTrackerProps) {
  const { status: liveStatus, connected } = useWebSocket(orderId);
  const currentStatus = liveStatus ?? initialStatus;
  const currentIdx = STATUS_ORDER.indexOf(currentStatus);
  const animated = useFeatureFlags().isEnabled("ab_animated_tracker");
  const motionClass = animated ? "transition-colors duration-500" : "";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-neutral-300"}`} />
        <span className="text-xs text-neutral-400">{connected ? "Live" : "Connecting..."}</span>
      </div>

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
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
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
    </div>
  );
}
