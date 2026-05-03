import { useMemo } from "react";
import { CellRow } from "./CellRow";
import { parseAnsi } from "./parseAnsi";
import { formatCwd, formatDuration } from "./formatBlockMeta";
import type { Block as BlockType } from "./types";

interface Props {
  block: BlockType;
}

/** Agent binaries whose closed transcripts are unreadable as linear text. */
const AGENT_NAMES = new Set(["claude", "codex", "aider", "gemini"]);

/**
 * True when `input` invokes one of our known TUI agents. Strips leading
 * env-var assignments (`FOO=bar claude`) and resolves the basename so
 * wrapper paths still match. Mirrors the logic in BlockTerminal so the
 * two stay in lockstep.
 */
function isAgentInput(input: string): boolean {
  const tokens = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (/^[a-z_][a-z0-9_]*=/i.test(t)) continue;
    const prog = t.split("/").pop() ?? t;
    return AGENT_NAMES.has(prog);
  }
  return false;
}

/**
 * One closed command block, Warp-style.
 *
 *   Top:    cwd + duration, small dim (e.g. "~ (0.046s)")
 *   Middle: the typed command in primary text, bold
 *   Bottom: the command's output, ANSI-parsed so colors from
 *           `git diff`, `cargo`, `rg`, etc. carry through
 *
 * We skip the transcript's first line in the body because the
 * segmenter captures *everything* between OSC 133 A and D — including
 * zsh's echo of the user's typed command. That echo would show up as a
 * duplicate of the bold command line we render above. We skip line 0
 * only when block.input is populated (the typical sendLine flow);
 * blocks with empty input keep the full transcript so we don't drop
 * content.
 */
export function Block({ block }: Props) {
  const isAgent = useMemo(() => isAgentInput(block.input), [block.input]);
  const lines = useMemo(
    // Skip ANSI parsing for agent transcripts — their linearized form
    // is unreadable (cursor positioning collapses columns into wordsmush
    // like "AUTHORISEDANDMAKESENSE"). The body renders a compact
    // "session ended" placeholder instead.
    () => (isAgent ? [] : parseAnsi(block.transcript)),
    [block.transcript, isAgent],
  );
  const bodyLines = useMemo(() => {
    if (block.input.length > 0 && lines.length > 0) return lines.slice(1);
    return lines;
  }, [lines, block.input]);

  const exitBadge = useMemo(() => {
    if (block.exit_code === null) return null;
    if (block.exit_code === 0) return null; // success is the default — show nothing
    return {
      label: `exit ${block.exit_code}`,
      color: "var(--state-error-bright)",
    };
  }, [block.exit_code]);

  const hasBody = isAgent
    ? false
    : bodyLines.some(
        (line) => line.length > 0 && line.some((s) => s.text.length > 0),
      );

  const cwdLabel = formatCwd(block.cwd);
  const durLabel = formatDuration(block.durationMs);

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
      {(cwdLabel || durLabel || exitBadge || isAgent) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-2xs)",
            marginBottom: 2,
          }}
        >
          {cwdLabel && <span>{cwdLabel}</span>}
          {durLabel && <span>({durLabel})</span>}
          {/* "ENDED" pill: balances LiveBlock's "RUNNING" pill so the
              user can tell stacked blocks apart at a glance. Only on
              clean exits — non-zero exit codes already get their own
              colored badge in this slot. */}
          {!exitBadge && (
            <span
              aria-label="ended"
              style={{
                marginLeft: "auto",
                color: "var(--text-disabled)",
                letterSpacing: "var(--tracking-caps)",
                textTransform: "uppercase",
                fontFamily: "var(--font-sans)",
              }}
            >
              ended
            </span>
          )}
          {exitBadge && (
            <span style={{ color: exitBadge.color, marginLeft: "auto" }}>
              {exitBadge.label}
            </span>
          )}
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
        }}
      >
        {block.input}
      </div>
      {hasBody && (
        <div style={{ color: "var(--text-secondary)" }}>
          {bodyLines.map((spans, i) => (
            <CellRow key={i} spans={spans} wrap />
          ))}
        </div>
      )}
    </div>
  );
}
