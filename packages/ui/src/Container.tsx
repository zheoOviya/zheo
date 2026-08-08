import type { HTMLAttributes, ReactNode } from "react";

export type ContainerMaxWidth = "2xl" | "3xl" | "5xl" | "7xl" | "full";

const maxWidthStyles: Record<ContainerMaxWidth, string> = {
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "5xl": "max-w-5xl",
  "7xl": "max-w-7xl",
  full: "max-w-none",
};

interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  maxWidth?: ContainerMaxWidth;
}

/**
 * Global layout container: owns horizontal rhythm (max-width, centering,
 * consistent mobile/desktop gutter). Pages must not re-apply px-* gutters.
 */
export function Container({
  children,
  maxWidth = "5xl",
  className = "",
  ...props
}: ContainerProps) {
  return (
    <div
      className={[
        "mx-auto w-full px-4 sm:px-6",
        maxWidthStyles[maxWidth],
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}
