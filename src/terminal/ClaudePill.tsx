import { useEffect, useState } from "react";
import { computeClaudeUsage } from "@/lib/claudeUsage";

interface Props {
  /** Wall-clock millis when Claude was first detected in this session. */
  startedAt: number;
}

/**
 * Compact Claude-session indicator. Lives inside TerminalStatusBar
 * alongside the cwd/branch/diff pills — same height, same chrome —
 * so the 5-hour usage info doesn't claim a whole row of vertical
 * space. Shows just the asterisk mark + time remaining, color-toned
 * by how full the window is. Full-text breakdown lives in the
 * tooltip.
 */
export function ClaudePill({ startedAt }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const { remainingMs, fractionUsed, remainingLabel } = computeClaudeUsage(
    startedAt,
    now,
  );

  const tone =
    remainingMs <= 30 * 60 * 1000
      ? "var(--state-error)"
      : fractionUsed >= 0.7
        ? "var(--state-warning)"
        : "var(--state-success)";

  // Percent USED of the 5h window. Floor instead of round so a fresh
  // session reads "0%" instead of jumping to "1%" within the first
  // few minutes.
  const percentUsed = Math.min(99, Math.floor(fractionUsed * 100));

  return (
    <span
      role="status"
      title={`Claude session — ${percentUsed}% used · ${remainingLabel} until reset`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1-5)",
        height: 16,
        padding: "0 var(--space-1-5)",
        flexShrink: 0,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        letterSpacing: "var(--tracking-tight)",
      }}
    >
      <ClaudeMark color="var(--state-warning)" />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          fontVariantNumeric: "tabular-nums",
          color: tone,
          fontWeight: "var(--weight-medium)",
        }}
      >
        {percentUsed}%
      </span>
      <span
        aria-hidden
        style={{
          color: "var(--text-disabled)",
          fontFamily: "var(--font-mono)",
        }}
      >
        ·
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          fontVariantNumeric: "tabular-nums",
          color: "var(--text-tertiary)",
        }}
      >
        {remainingLabel}
      </span>
    </span>
  );
}

function ClaudeMark({ color }: { color: string }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0, color }}
    >
      <path
        d="M6 1.2 V10.8 M1.5 3.4 L10.5 8.6 M1.5 8.6 L10.5 3.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
