import { Skeleton } from "@snakzap/ui";

// Teal-shimmer skeleton shown while the RSC payload streams.
// Mirrors the RestaurantGrid layout 1:1 to guarantee zero layout shift.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Skeleton className="mb-6 h-8 w-32" />
      <Skeleton className="mb-8 h-12 w-full rounded-full" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-xl bg-white">
            <Skeleton className="aspect-square w-full rounded-none" />
            <div className="space-y-2 p-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
