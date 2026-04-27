import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { computeClaudeUsage } from "@/lib/claudeUsage";

interface Props {
  /** Wall-clock millis when Claude was first detected in this session. */
  startedAt: number;
}

/**
 * Slim footer strip that lives at the bottom of the terminal pane
 * whenever Claude has been detected in the PTY output. Shows time
 * remaining in the current 5-hour Anthropic usage window plus a thin
 * progress hairline.
 *
 * Designed to read at a glance and not distract — sage when fresh,
 * amber as the window fills, soft red in the last 30 minutes.
 */
export function ClaudeUsageBar({ startedAt }: Props) {
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

  return (
    <div
      role="status"
      aria-label={`Claude usage: ${remainingLabel} remaining`}
      style={{
        position: "relative",
        height: 32,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "0 var(--space-4)",
        backgroundColor: "var(--surface-1)",
        borderTop: "var(--border-1)",
        borderBottomLeftRadius: "var(--radius-md)",
        borderBottomRightRadius: "var(--radius-md)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        color: "var(--text-secondary)",
      }}
    >
      <ClaudeMark />

      <span
        style={{
          letterSpacing: "var(--tracking-tight)",
          color: "var(--text-secondary)",
        }}
      >
        Claude session
      </span>

      <span style={{ flex: 1 }} />

      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: tone,
          fontVariantNumeric: "tabular-nums",
          fontWeight: "var(--weight-medium)",
        }}
      >
        {remainingLabel}
      </span>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "var(--tracking-caps)",
        }}
      >
        until reset
      </span>

      {/* progress hairline */}
      <motion.span
        aria-hidden
        initial={false}
        animate={{ width: `${fractionUsed * 100}%` }}
        transition={{ duration: 0.6, ease: [0.25, 1, 0.5, 1] }}
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          height: 2,
          backgroundColor: tone,
          borderBottomLeftRadius: "var(--radius-md)",
          borderBottomRightRadius:
            fractionUsed > 0.98 ? "var(--radius-md)" : 0,
        }}
      />
    </div>
  );
}

function ClaudeMark() {
  // Anthropic's six-spoked asterisk, simplified to fit the 12px slot.
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--state-warning)",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M6 1.2 V10.8 M1.5 3.4 L10.5 8.6 M1.5 8.6 L10.5 3.4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
