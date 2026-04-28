import { memo } from "react";
import type { Span } from "./types";

interface Props {
  spans: Span[];
  /**
   * When true, soft-wrap long rows at whitespace and force-break
   * unbreakable runs. Used by closed blocks and the in-progress
   * LiveBlock so historical command output stays readable when the
   * pane is narrower than the PTY's column count.
   *
   * MUST stay false for alt-screen TUI grids (FullGrid for vim /
   * htop / claude) — those assume one visual line per grid row, and
   * any wrapping makes the rendered row count drift away from the
   * PTY's row count, which kicks the ResizeObserver into a feedback
   * loop and produces a visible jitter.
   */
  wrap?: boolean;
}

/**
 * Renders a single row of the terminal grid as styled `<span>` elements
 * — one DOM node per same-style run, not per character. A 120-col line
 * with 5 colors is 5 DOM nodes, not 120.
 *
 * Memoized so React skips reconciling rows that didn't change between
 * frames (the wire-level diff already drops unchanged rows, but a fresh
 * render of all currently-dirty rows still benefits when only the
 * cursor row inside that set actually changed contents).
 */
export const CellRow = memo(function CellRow({ spans, wrap = false }: Props) {
  return (
    <div
      style={{
        whiteSpace: wrap ? "pre-wrap" : "pre",
        overflowWrap: wrap ? "anywhere" : "normal",
        fontVariantLigatures: "none",
        lineHeight: "var(--cell-line-height, 1.35)",
      }}
    >
      {spans.map((span, i) => (
        <span
          key={i}
          style={{
            color: span.inverse ? span.bg : span.fg,
            backgroundColor: span.inverse ? span.fg : "transparent",
            fontWeight: span.bold ? 600 : 400,
            fontStyle: span.italic ? "italic" : "normal",
            textDecorationLine:
              [
                span.underline && "underline",
                span.strikeout && "line-through",
              ]
                .filter(Boolean)
                .join(" ") || "none",
            opacity: span.dim ? 0.6 : 1,
          }}
        >
          {span.text}
        </span>
      ))}
    </div>
  );
});
