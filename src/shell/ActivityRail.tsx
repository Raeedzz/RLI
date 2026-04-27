import {
  BrowserIcon,
  ConnectionsIcon,
  FolderIcon,
  GitIcon,
} from "@/primitives/Icon";
import {
  useActiveSession,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { leaves } from "@/state/paneTree";
import type { ReactNode } from "react";

/**
 * 40px vertical rail on the left edge.
 *
 * Six icon buttons that summon the major panels: files, search,
 * connections, browser, git (todo), settings. Each shows its
 * keyboard shortcut on hover. The active panel's icon gets a
 * 2px steel-blue strip flush to the rail's inner (right) edge so
 * it points toward the workspace it controls.
 */
export function ActivityRail() {
  const state = useAppState();
  const session = useActiveSession();
  const dispatch = useAppDispatch();
  // Derive browser visibility from the workspace tree so it stays in
  // sync whether the browser was opened via this button, dragged into
  // place, or closed via the pane × button.
  const browserVisible = session
    ? leaves(session.workspace).some((l) => l.content === "browser")
    : false;

  return (
    <aside
      style={{
        width: 40,
        flexShrink: 0,
        height: "100%",
        backgroundColor: "var(--surface-1)",
        borderRight: "var(--border-1)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--space-1)",
        padding: "var(--space-2) 0",
      }}
      role="toolbar"
      aria-label="Workspace tools"
    >
      <RailButton
        active={state.leftPanel === "files"}
        label="Files"
        chord="⌘B"
        onClick={() =>
          dispatch({ type: "toggle-left-panel", panel: "files" })
        }
      >
        <FolderIcon />
      </RailButton>

      <RailButton
        active={state.leftPanel === "git"}
        label="Source control"
        chord="⌃⇧G"
        onClick={() =>
          dispatch({ type: "toggle-left-panel", panel: "git" })
        }
      >
        <GitIcon />
      </RailButton>

      <RailButton
        active={state.leftPanel === "connections"}
        label="Skills & MCP"
        chord="⌘⇧;"
        onClick={() =>
          dispatch({ type: "toggle-left-panel", panel: "connections" })
        }
      >
        <ConnectionsIcon />
      </RailButton>

      <RailButton
        active={browserVisible}
        label="Browser"
        chord="⌘⇧B"
        onClick={() => dispatch({ type: "toggle-browser" })}
      >
        <BrowserIcon />
      </RailButton>

      <div style={{ flex: 1 }} />
    </aside>
  );
}

function RailButton({
  active,
  label,
  chord,
  onClick,
  disabled = false,
  children,
}: {
  active: boolean;
  label: string;
  chord: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={chord ? `${label}  ${chord}` : label}
      aria-label={label}
      aria-pressed={active}
      style={{
        position: "relative",
        width: 28,
        height: 28,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-md)",
        backgroundColor: active
          ? "var(--surface-accent-tinted)"
          : "transparent",
        color: disabled
          ? "var(--text-disabled)"
          : active
            ? "var(--accent-bright)"
            : "var(--text-tertiary)",
        cursor: "default",
        opacity: disabled ? 0.5 : 1,
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (!active) {
          e.currentTarget.style.backgroundColor =
            "var(--surface-accent-soft)";
          e.currentTarget.style.color = "var(--text-primary)";
        }
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        if (!active) {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--text-tertiary)";
        }
      }}
    >
      {children}
      {active && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: -8,
            top: 4,
            bottom: 4,
            width: 2,
            backgroundColor: "var(--accent-bright)",
            borderRadius: "var(--radius-pill)",
          }}
        />
      )}
    </button>
  );
}
