interface TealSkeletonProps {
  className?: string;
}

export default function TealSkeleton({ className = "" }: TealSkeletonProps) {
  return (
    <div
      className={`animate-skeleton-teal rounded-lg bg-primary-500/15 ${className}`}
    />
  );
}
