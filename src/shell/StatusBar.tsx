import { useActiveProject, useActiveSession } from "@/state/AppState";
import { tagVar } from "@/state/types";
import { ClaudePill } from "@/terminal/ClaudePill";

/**
 * Always-on 24px context strip at the bottom.
 *
 * Carries the active session's live subtitle plus a 2px tag-colored
 * left strip that mirrors the project's identity color — so the user
 * gets a quiet visual cue of which project they're in without another
 * label.
 */
export function StatusBar() {
  const session = useActiveSession();
  const project = useActiveProject();
  const projectColor = tagVar(project?.color);

  return (
    <footer
      style={{
        height: 24,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-3) 0 var(--space-4)",
        backgroundColor: "var(--surface-1)",
        borderTop: "var(--border-1)",
        boxShadow: `inset 2px 0 0 0 ${projectColor}`,
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
        {session?.agentRunning && session?.claudeStartedAt != null && (
          <ClaudePill startedAt={session.claudeStartedAt} />
        )}
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
  if (s === "streaming") return "var(--accent-bright)";
  if (s === "error") return "var(--state-error-bright)";
  return "var(--state-success)";
}

function statusLabel(s: "idle" | "streaming" | "error"): string {
  if (s === "streaming") return "agent is working…";
  if (s === "error") return "agent error";
  return "idle";
}
