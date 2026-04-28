/**
 * Format the small dim header above each terminal block.
 *
 *   ~ (0.046s)
 *   ~/Developer/RLI/src-tauri (1.7s)
 *   ./tests (12.3s)
 */

const HOME_RE = /^\/Users\/[^/]+/;

export function formatCwd(cwd: string | null | undefined): string {
  if (!cwd) return "";
  return cwd.replace(HOME_RE, "~");
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 100) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(3)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
