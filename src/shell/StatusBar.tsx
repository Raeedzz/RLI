import { useActiveSession } from "@/state/AppState";

/**
 * Always-on 24px context strip at the bottom.
 *
 * Now carries the active session's live subtitle (the hero feature) —
 * since session tabs at top are single-line and don't show subtitles.
 *
 *   ● rli/fix-oauth-redirect-bug · Refactoring AuthProvider…       ⌘K commands
 */
export function StatusBar() {
  const session = useActiveSession();

  return (
    <footer
      style={{
        height: 24,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-3)",
        backgroundColor: "var(--surface-1)",
        borderTop: "var(--border-1)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        userSelect: "none",
        gap: "var(--space-3)",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {session ? (
          <>
            <Dot color={statusColor(session.status)} />
            <Mono>{session.branch}</Mono>
            <Sep />
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--text-secondary)",
              }}
            >
              {session.subtitle || statusLabel(session.status)}
            </span>
          </>
        ) : (
          <span>no active session</span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          flexShrink: 0,
        }}
      >
        <span>
          <Mono>⌘K</Mono> commands
        </span>
      </div>
    </footer>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
      }}
    >
      {children}
    </span>
  );
}

function Sep() {
  return <span style={{ color: "var(--text-disabled)" }}>·</span>;
}

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "var(--radius-pill)",
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

function statusColor(s: "idle" | "streaming" | "error"): string {
  if (s === "streaming") return "var(--accent)";
  if (s === "error") return "var(--state-error)";
  return "var(--text-tertiary)";
}

function statusLabel(s: "idle" | "streaming" | "error"): string {
  if (s === "streaming") return "agent is working…";
  if (s === "error") return "agent error";
  return "idle";
}
