import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  cta?: ReactNode;
  children?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  cta,
  children,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-label={title}
      className="flex flex-col items-center justify-center px-6 py-16 text-center"
    >
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-primary-500/10">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-neutral-700">{title}</h3>
      {description && (
        <p className="mt-2 max-w-xs text-sm leading-relaxed text-neutral-400">
          {description}
        </p>
      )}
      {cta && <div className="mt-6">{cta}</div>}
      {children}
    </div>
  );
}
