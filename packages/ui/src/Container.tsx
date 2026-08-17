import type { ElementType, HTMLAttributes, ReactNode } from "react";

export type ContainerMaxWidth = "2xl" | "3xl" | "4xl" | "5xl" | "6xl" | "7xl" | "full";

const maxWidthStyles: Record<ContainerMaxWidth, string> = {
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-7xl",
  full: "max-w-none",
};

interface ContainerProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  /** Element to render as (defaults to a `div`). Use `as="main"` for a page landmark. */
  as?: ElementType;
  maxWidth?: ContainerMaxWidth;
  /** Owns the horizontal gutter (px-4 sm:px-6). Disable when a parent layout already pads. */
  gutter?: boolean;
}

/**
 * Global layout container: owns horizontal rhythm (max-width, centering,
 * consistent mobile/desktop gutter). Pages must not re-apply px-* gutters
 * unless they pass `gutter={false}` (their parent already handles padding).
 */
export function Container({
  children,
  as: Tag = "div",
  maxWidth = "5xl",
  gutter = true,
  className = "",
  ...props
}: ContainerProps) {
  return (
    <Tag
      className={[
        "mx-auto w-full",
        gutter ? "px-4 sm:px-6" : "",
        maxWidthStyles[maxWidth],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {children}
    </Tag>
  );
}
