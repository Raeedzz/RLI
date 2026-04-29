import { memo, type CSSProperties } from "react";
import type { Span } from "./types";
import { splitUrls } from "@/lib/urlMatch";

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
 * URLs in span text get split out into clickable `<a>` elements that
 * dispatch a `rli:open-url` event — the AppShell catches it and routes
 * the URL into the active session's in-app browser pane (opening one
 * if needed). That keeps `localhost:5173` and friends inside the CLI
 * instead of bouncing to the OS default browser.
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
      {spans.map((span, i) => {
        const baseStyle: CSSProperties = {
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
        };
        const fragments = splitUrls(span.text);
        // Hot path: no URLs in this span — render as a single styled
        // <span>, same as before.
        if (fragments.length <= 1 && fragments[0]?.kind !== "url") {
          return (
            <span key={i} style={baseStyle}>
              {span.text}
            </span>
          );
        }
        return (
          <span key={i} style={baseStyle}>
            {fragments.map((f, j) =>
              f.kind === "text" ? (
                <span key={j}>{f.text}</span>
              ) : (
                <UrlSpan key={j} text={f.text} url={f.url} />
              ),
            )}
          </span>
        );
      })}
    </div>
  );
});

function UrlSpan({ text, url }: { text: string; url: string }) {
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("rli:open-url", { detail: { url } }),
        );
      }}
      style={{
        color: "var(--accent-bright)",
        textDecorationLine: "underline",
        textUnderlineOffset: 2,
        cursor: "pointer",
      }}
      title={`Open ${url} in the in-app browser pane`}
    >
      {text}
    </a>
  );
}
