import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** surface-0 (terminals/editors), surface-1 (default), surface-2 (raised) */
  surface?: "0" | "1" | "2";
}

/**
 * Bare pane. No header chrome by default — the surrounding terminal/editor
 * fills the entire pane. Per Warp aesthetic: chrome should disappear.
 *
 * If a pane needs a label or actions, render them inline within children
 * (typically inside the terminal/editor's own UI).
 */
export function Pane({ children, surface = "0" }: Props) {
  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        backgroundColor: `var(--surface-${surface})`,
        overflow: "hidden",
        position: "relative",
        minHeight: 0,
      }}
    >
      {children}
    </div>
  );
}
