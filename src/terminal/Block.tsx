import { useMemo } from "react";
import { CellRow } from "./CellRow";
import { parseAnsi } from "./parseAnsi";
import type { Block as BlockType } from "./types";

interface Props {
  block: BlockType;
}

/**
 * One closed command block. Header is the user's input echoed back
 * with an accent caret + (when present) an exit-code badge. Body is
 * the command's output, ANSI-parsed so colors from `git diff`,
 * `cargo`, `rg`, etc. carry through into the closed block.
 *
 * Why we skip the transcript's first line in the body: the segmenter
 * captures *everything* between OSC 133 A and D — including zsh's
 * echo of the user's typed command. That echo would show up as a
 * duplicate of the synthetic `❯ <input>` header. We skip line 0 only
 * when block.input is populated (the typical sendLine flow); blocks
 * with empty input keep the full transcript so we don't drop content.
 */
export function Block({ block }: Props) {
  const lines = useMemo(() => parseAnsi(block.transcript), [block.transcript]);
  const bodyLines = useMemo(() => {
    if (block.input.length > 0 && lines.length > 0) return lines.slice(1);
    return lines;
  }, [lines, block.input]);

  const exitBadge = useMemo(() => {
    if (block.exit_code === null) return null;
    if (block.exit_code === 0) {
      return {
        label: "✓",
        bg: "var(--surface-success-soft)",
        color: "var(--state-success)",
      };
    }
    return {
      label: `${block.exit_code}`,
      bg: "var(--surface-error-soft)",
      color: "var(--state-error-bright)",
    };
  }, [block.exit_code]);

  const hasBody = bodyLines.some(
    (line) => line.length > 0 && line.some((s) => s.text.length > 0),
  );

  return (
    <div
      style={{
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
        <span aria-hidden style={{ color: "var(--accent-bright)", fontWeight: 600 }}>
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
          {block.input}
        </span>
        {exitBadge && (
          <span
            style={{
              padding: "1px var(--space-1-5)",
              borderRadius: "var(--radius-xs)",
              backgroundColor: exitBadge.bg,
              color: exitBadge.color,
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-sans)",
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {exitBadge.label}
          </span>
        )}
      </div>
      {hasBody && (
        <div style={{ color: "var(--text-secondary)" }}>
          {bodyLines.map((spans, i) => (
            <CellRow key={i} spans={spans} />
          ))}
        </div>
      )}
    </div>
  );
}
