/**
 * Claude usage tracking — Anthropic enforces a rolling-ish 5-hour
 * window per account. RLI shows the user how much of that window has
 * been consumed since the first time Claude was detected in this
 * session, so they don't get surprised by a rate-limit mid-task.
 *
 * The window is approximated locally — it begins when we first detect
 * Claude in PTY output and resets after 5 hours of wall-clock time.
 * If the real Anthropic-side window is shorter, the worst case is the
 * counter shows more time remaining than the user actually has; we'll
 * tighten this when Anthropic exposes the window through an API.
 */

export const CLAUDE_WINDOW_MS = 5 * 60 * 60 * 1000;

const CLAUDE_MARKERS = [
  "claude code",
  "welcome to claude",
  "anthropic.com",
  "✻ welcome",          // Claude TUI banner glyph
];

/**
 * Returns true if the text contains a confident marker that Claude is
 * running in this PTY. Case-insensitive substring match against a
 * fixed set of phrases that only appear when the Claude CLI starts.
 */
export function detectClaude(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CLAUDE_MARKERS.some((m) => lower.includes(m));
}

export interface ClaudeUsageStatus {
  /** Milliseconds remaining in the current 5h window. */
  remainingMs: number;
  /** Window-progress 0..1. */
  fractionUsed: number;
  /** "1h 23m" / "12m" style label. */
  remainingLabel: string;
}

export function computeClaudeUsage(
  startedAt: number,
  now: number = Date.now(),
): ClaudeUsageStatus {
  const elapsed = Math.max(0, now - startedAt);
  const remainingMs = Math.max(0, CLAUDE_WINDOW_MS - elapsed);
  const fractionUsed = Math.min(1, elapsed / CLAUDE_WINDOW_MS);
  return {
    remainingMs,
    fractionUsed,
    remainingLabel: formatDuration(remainingMs),
  };
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}
