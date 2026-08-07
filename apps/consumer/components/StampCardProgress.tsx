"use client";

// ============================================
// L01 Stamp Card (UI/UX Agent)
// 10 circles that fill Teal as pickups happen.
// When rewards_earned > 0 the card shows how many
// free items are unlocked (amber accent pills).
// ============================================

export const STAMP_CARD_SIZE = 10;

interface StampCardProgressProps {
  stampCount: number;
  rewardsEarned?: number;
  size?: number;
}

export default function StampCardProgress({
  stampCount,
  rewardsEarned = 0,
  size = STAMP_CARD_SIZE,
}: StampCardProgressProps) {
  const filled = Math.max(0, Math.min(stampCount, size));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {Array.from({ length: size }).map((_, i) => {
          const isFilled = i < filled;
          return (
            <div
              key={i}
              className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                isFilled
                  ? "bg-primary-500 text-white shadow-sm"
                  : "border-2 border-primary-200 bg-surface-light text-primary-300"
              }`}
              title={isFilled ? `Stamp ${i + 1}` : "Collect this stamp on your next pickup"}
            >
              {i + 1}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="text-sm text-neutral-500">
          <span className="font-semibold text-primary-700">{filled}</span> / {size} pickups
        </p>
        {rewardsEarned > 0 && (
          <span className="rounded-full bg-accent-100 px-3 py-1 text-xs font-bold text-accent-700">
            {rewardsEarned} FREE ITEM{rewardsEarned > 1 ? "S" : ""} UNLOCKED
          </span>
        )}
      </div>
    </div>
  );
}
