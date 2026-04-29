import type { CSSProperties } from "react";
import type { SessionStatus } from "@/state/types";

interface Props {
  status: SessionStatus;
  /** Optional color override (CSS color expression). When set, replaces the
   *  status-derived color. The pulse animation for `streaming` still applies. */
  color?: string;
  /**
   * When true (a prompt is running) the dot renders as a hollow gray
   * outline. When false / undefined (idle, prompt done) the dot is the
   * solid filled colour. A simple, unambiguous "busy vs done" cue
   * without leaning on the existing `streaming` status, which doesn't
   * always reflect the agent's per-prompt state.
   */
  running?: boolean;
  size?: number;
}

const STATUS_COLOR: Record<SessionStatus, string> = {
  streaming: "var(--accent)",
  idle: "var(--text-tertiary)",
  error: "var(--state-error)",
};

/**
 * 6px dot used in session tabs, project pill, status bar.
 *
 * The dot is always solid-filled. Color flips based on agent state:
 *   - `running={true}`  → gray (`--text-tertiary`)
 *   - `running` falsy   → the supplied `color` (or the status-derived
 *                         fallback). The "back to its colour" state.
 *
 * Pulses opacity when `status === "streaming"` (CSS keyframe `rli-pulse`
 * from motion.css).
 */
export function StatusDot({ status, color, running, size = 6 }: Props) {
  const fill = running
    ? "var(--text-tertiary)"
    : (color ?? STATUS_COLOR[status]);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "var(--radius-pill)",
    backgroundColor: fill,
    flexShrink: 0,
    transition: "background-color var(--motion-base) var(--ease-out-quart)",
  };

  return (
    <span
      className={status === "streaming" ? "rli-pulse" : undefined}
      style={style}
      aria-label={running ? "agent running" : `agent ${status}`}
    />
  );
}
