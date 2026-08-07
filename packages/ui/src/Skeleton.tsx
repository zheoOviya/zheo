// Shared UI primitives - teal-shimmer skeleton (UI/UX Agent mandate:
// zero layout shift, no spinners, teal palette only).
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`animate-skeleton-teal rounded-md bg-primary-500/30 ${className ?? ""}`}
      {...props}
    />
  );
}
