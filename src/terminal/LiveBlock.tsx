import { useEffect, useMemo, useRef, useState } from "react";
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
export function LiveBlock({ command, frame, fill = false, cwd }: Props) {
  const visibleRows = useMemo(() => {
    if (!frame) return [];
    return trimEchoAndBlanks(frame.dirty, command);
  }, [frame, command]);

  const hasBody = visibleRows.length > 0;
  const cwdLabel = formatCwd(cwd);

  // Live duration counter — same look as closed blocks but updated
  // every 100ms so the user can see the command time accumulate.
  const startRef = useRef<number>(Date.now());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    startRef.current = Date.now();
    setTick(0);
    const id = window.setInterval(
      () => setTick((t) => t + 1),
      100,
    );
    return () => window.clearInterval(id);
  }, [command]);
  const elapsedLabel = formatDuration(Date.now() - startRef.current);
  void tick;

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
      {(cwdLabel || elapsedLabel) && (
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
          {elapsedLabel && <span>({elapsedLabel})</span>}
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
      {hasBody && (
        <div
          style={{
            color: "var(--text-secondary)",
            flex: fill ? "1 1 0" : undefined,
            minHeight: fill ? 0 : undefined,
            overflow: fill ? "auto" : undefined,
          }}
        >
          {visibleRows.map((row) => (
            <CellRow key={row.row} spans={row.spans} />
          ))}
        </div>
      )}
    </div>
  );
}
