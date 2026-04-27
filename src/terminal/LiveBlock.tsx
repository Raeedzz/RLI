import { useMemo } from "react";
import { CellRow } from "./CellRow";
import type { DirtyRow, RenderFrame } from "./types";

interface Props {
  /** What the user typed to start the running command. */
  command: string;
  /** Live rows from the current command's output. */
  frame: RenderFrame | null;
}

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
export function LiveBlock({ command, frame }: Props) {
  const visibleRows = useMemo(() => {
    if (!frame) return [];
    return trimEchoAndBlanks(frame.dirty, command);
  }, [frame, command]);

  const hasBody = visibleRows.length > 0;

  return (
    <div
      style={{
        flexShrink: 0,
        maxHeight: "60vh",
        overflowY: "auto",
        padding: "var(--space-2) var(--space-3)",
        borderTop: "var(--border-1)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        fontVariantLigatures: "none",
        color: "var(--text-primary)",
        userSelect: "text",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          paddingBottom: hasBody ? "var(--space-1-5)" : 0,
          marginBottom: hasBody ? "var(--space-1-5)" : 0,
          borderBottom: hasBody ? "var(--border-1)" : "none",
          color: "var(--text-secondary)",
        }}
      >
        <span
          aria-hidden
          style={{ color: "var(--accent-bright)", fontWeight: 600 }}
        >
          ❯
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {command}
        </span>
        <span
          aria-label="running"
          style={{
            padding: "1px var(--space-1-5)",
            borderRadius: "var(--radius-xs)",
            backgroundColor: "var(--surface-2)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-2xs)",
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            flexShrink: 0,
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          running
        </span>
      </div>
      {hasBody && (
        <div style={{ color: "var(--text-secondary)" }}>
          {visibleRows.map((row) => (
            <CellRow key={row.row} spans={row.spans} />
          ))}
        </div>
      )}
    </div>
  );
}
