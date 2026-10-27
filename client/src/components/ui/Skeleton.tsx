import type { CSSProperties } from "react";
import { cx } from "./Button";

/** Placeholder block in the shape of the real component. Put aria-busy on the container. */
export function Skeleton({ width, height, aspect, radius, className, style }:
  { width?: CSSProperties["width"]; height?: CSSProperties["height"]; aspect?: string; radius?: string; className?: string; style?: CSSProperties }) {
  return <div className={cx("skeleton", className)} aria-hidden="true" style={{ width, height, aspectRatio: aspect, borderRadius: radius, ...style }} />;
}

/** Text lines; the last one is shorter. */
export function SkeletonText({ lines = 2, width = "100%" }: { lines?: number; width?: CSSProperties["width"] }) {
  return (
    <div style={{ display: "grid", gap: "var(--space-2)", width }} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton skeleton-text" style={{ width: i === lines - 1 && lines > 1 ? "60%" : "100%" }} />)}
    </div>
  );
}
