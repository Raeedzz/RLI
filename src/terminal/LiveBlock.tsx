import { useEffect, useMemo, useRef } from "react";
import { CanvasGrid, isCanvasRendererEnabled } from "./CanvasGrid";
import { CellRow } from "./CellRow";
import { formatCwd, formatDuration } from "./formatBlockMeta";
import type { DirtyRow, RenderFrame } from "./types";

interface Props {
  /** What the user typed to start the running command. */
  command: string;
  /** Live rows from the current command's output. */
  frame: RenderFrame | null;
  /**
   * When true, the block fills the pane (claude/codex own the surface).
   * Otherwise it sizes to content and shares scroll with BlockList.
   */
  fill?: boolean;
  /** cwd at command start, for the small dim header. */
  cwd?: string;
  /**
   * When true, render rows as a fixed-grid TUI surface — no wrap, no
   * width-driven reflow. Used when the running command is an
   * interactive agent (claude / codex / aider) whose UI assumes one
   * visual line per grid row. Independent of `fill` so the block can
   * sit inline in the conversation scroll without breaking the
   * agent's layout.
   */
  preserveGrid?: boolean;
}

/**
 * The "in-progress block" — what's running right now. In shell mode it
 * shares its parent scroll with the BlockList above; in agent mode
 * (claude/codex) it gets the full pane height since the agent owns the
 * surface.
 */

function rowIsBlank(row: DirtyRow): boolean {
  for (const s of row.spans) {
    if (s.text.trim().length > 0) return false;
  }
  return true;
}

function rowText(row: DirtyRow): string {
  return row.spans.map((s) => s.text).join("").trim();
}

/**
 * Strip leading blanks + zsh's echo of the typed command, plus
 * trailing blanks. Same shape as the closed-block transcript trim
 * (`Block.tsx` skips line 0 when input matches), kept consistent so
 * a running block and its eventual closed block look visually
 * continuous when the command finishes.
 */
function trimEchoAndBlanks(rows: DirtyRow[], command: string): DirtyRow[] {
  const target = command.trim();
  let i = 0;
  while (i < rows.length && rowIsBlank(rows[i])) i++;
  if (i < rows.length && target.length > 0 && rowText(rows[i]) === target) {
    i++;
  }
  let j = rows.length - 1;
  while (j >= i && rowIsBlank(rows[j])) j--;
  if (i > j) return [];
  return rows.slice(i, j + 1);
}

/**
 * The "in-progress block" — what's running right now. Visually
 * matches `Block.tsx` so the moment a command finishes and the live
 * block is replaced by a closed block, the swap is invisible. The
 * synthetic ❯ + command header makes the user's input look like a
 * "user message" in a chat (Warp-style) instead of a floating echo.
 */
export function LiveBlock({
  command,
  frame,
  fill = false,
  cwd,
  preserveGrid = false,
}: Props) {
  const visibleRows = useMemo(() => {
    if (!frame) return [];
    return trimEchoAndBlanks(frame.dirty, command);
  }, [frame, command]);

  const hasBody = visibleRows.length > 0;
  const cwdLabel = formatCwd(cwd);

  // Live duration counter — same look as closed blocks but updated
  // every animation frame so the user sees the command time accumulate
  // smoothly. The label is written directly into a ref-bound <span>
  // via `textContent`, never via React state. This avoids ~10
  // unnecessary commits per second per running command — at 20 active
  // panes that's ~200 component-level rerenders/s, all on the React
  // critical path. rAF + DOM write puts the work on the compositor
  // instead and frees the main thread for actual user input.
  const startRef = useRef<number>(Date.now());
  const durationRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    startRef.current = Date.now();
    let cancelled = false;
    let raf = 0;
    let lastLabel = "";
    const paint = () => {
      if (cancelled) return;
      const label = formatDuration(Date.now() - startRef.current);
      if (label !== lastLabel) {
        lastLabel = label;
        const node = durationRef.current;
        if (node) node.textContent = `(${label})`;
      }
      raf = requestAnimationFrame(paint);
    };
    // Prime once synchronously so the first paint already shows a
    // sensible duration; rAF takes over after that.
    paint();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [command]);
  // Initial label at first render. Subsequent updates are written
  // directly into `durationRef.current` by the rAF loop — React never
  // commits them.
  const initialElapsedLabel = formatDuration(Date.now() - startRef.current);

  return (
    <div
      style={{
        flex: fill ? "1 1 0" : "0 0 auto",
        minHeight: fill ? 0 : undefined,
        overflow: fill ? "hidden" : undefined,
        display: "flex",
        flexDirection: "column",
        padding: "var(--space-2) var(--space-3)",
        borderTop: "var(--border-1)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        fontVariantLigatures: "none",
        color: "var(--text-primary)",
        userSelect: "text",
      }}
    >
      {(cwdLabel || initialElapsedLabel) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-2xs)",
            marginBottom: 2,
            flexShrink: 0,
          }}
        >
          {cwdLabel && <span>{cwdLabel}</span>}
          {initialElapsedLabel && (
            <span ref={durationRef}>({initialElapsedLabel})</span>
          )}
          <span
            aria-label="running"
            style={{
              marginLeft: "auto",
              color: "var(--accent-bright)",
              letterSpacing: "var(--tracking-caps)",
              textTransform: "uppercase",
              fontFamily: "var(--font-sans)",
            }}
          >
            running
          </span>
        </div>
      )}
      <div
        style={{
          fontWeight: 600,
          color: "var(--text-primary)",
          paddingBottom: hasBody ? "var(--space-1-5)" : 0,
          marginBottom: hasBody ? "var(--space-1-5)" : 0,
          borderBottom: hasBody ? "var(--border-1)" : "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {command}
      </div>
      {hasBody ? (
        <div
          style={{
            color: "var(--text-secondary)",
            flex: fill ? "1 1 0" : undefined,
            minHeight: fill ? 0 : undefined,
            overflow: fill ? "auto" : undefined,
          }}
        >
          {/* Phase 3 canvas path: when the flag is on AND this block
              is rendering an agent's TUI (preserveGrid), swap the DOM
              CellRow stack for a content-sized CanvasGrid. Shell
              command output stays on the DOM path because canvas
              doesn't soft-wrap yet — Phase 4. */}
          {preserveGrid && isCanvasRendererEnabled() && frame ? (
            <CanvasGrid frame={frame} rows={visibleRows} mode="auto" />
          ) : (
            visibleRows.map((row) => (
              // Shell command output wraps so it reads cleanly in narrow
              // panes. Agent TUIs (`preserveGrid=true`) keep one visual
              // line per grid row — wrapping their UI would scramble
              // claude's box-drawing and shift columns mid-frame.
              <CellRow
                key={row.row}
                spans={row.spans}
                wrap={!preserveGrid && !fill}
              />
            ))
          )}
        </div>
      ) : (
        // Empty-body state. In agent mode (fill=true) this is the gap
        // between OSC 133 C clearing the grid and the agent painting
        // its first frame — without a placeholder the pane flashes
        // pure surface-0 (looks black) for ~50–200 ms while claude
        // initializes its TUI. A subtle "starting…" matches the
        // header's monospace and makes the gap feel intentional.
        fill && (
          <div
            style={{
              flex: "1 1 0",
              minHeight: 0,
              display: "grid",
              placeItems: "center",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-xs)",
              fontFamily: "var(--font-mono)",
              userSelect: "none",
            }}
          >
            starting {command}…
          </div>
        )
      )}
    </div>
  );
}
