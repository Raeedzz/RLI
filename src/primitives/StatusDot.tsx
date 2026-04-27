import type { CSSProperties } from "react";
import type { SessionStatus } from "@/state/types";

interface Props {
  status: SessionStatus;
  /** Optional color override (CSS color expression). When set, replaces the
   *  status-derived color. The pulse animation for `streaming` still applies. */
  color?: string;
  size?: number;
}

const STATUS_COLOR: Record<SessionStatus, string> = {
  streaming: "var(--accent)",
  idle: "var(--text-tertiary)",
  error: "var(--state-error)",
};

/**
 * 6px dot used in session tabs, project pill, status bar.
 * Pulses opacity when streaming (CSS keyframe `rli-pulse` from motion.css).
 */
export function StatusDot({ status, color, size = 6 }: Props) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "var(--radius-pill)",
    backgroundColor: color ?? STATUS_COLOR[status],
    flexShrink: 0,
    transition: "background-color var(--motion-base) var(--ease-out-quart)",
  };

  return (
    <span
      className={status === "streaming" ? "rli-pulse" : undefined}
      style={style}
      aria-label={`agent ${status}`}
    />
  );
}
