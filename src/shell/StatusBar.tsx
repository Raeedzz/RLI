import { AnimatePresence } from "motion/react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { useActiveProject, useActiveSession, useAppDispatch } from "@/state/AppState";
import { tagVar } from "@/state/types";
import { ClaudePill } from "@/terminal/ClaudePill";
import { BranchSwitcher } from "./BranchSwitcher";

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
  const dispatch = useAppDispatch();
  const projectColor = tagVar(project?.color);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);

  const openPicker = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPicker({ x: e.clientX, y: e.clientY });
  };

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
            <BranchButton
              label={session.branch}
              onClick={openPicker}
              disabled={!project}
            />
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
      <AnimatePresence>
        {picker && project && session && (
          <BranchSwitcher
            cwd={project.path}
            anchor={picker}
            onClose={() => setPicker(null)}
            onSwitched={(branch) => {
              dispatch({
                type: "update-session",
                id: session.id,
                patch: { branch },
              });
            }}
          />
        )}
      </AnimatePresence>
    </footer>
  );
}

function BranchButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: (e: ReactMouseEvent) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title="switch branch"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 18,
        padding: "0 var(--space-1-5)",
        backgroundColor: "transparent",
        border: "none",
        borderRadius: "var(--radius-xs)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        cursor: disabled ? "default" : "pointer",
        transition: "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = "var(--surface-2)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      {label}
      <span aria-hidden style={{ opacity: 0.5, fontSize: 8 }}>▾</span>
    </button>
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
