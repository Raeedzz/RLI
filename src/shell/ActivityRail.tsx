import {
  BrowserIcon,
  ConnectionsIcon,
  FolderIcon,
  GitIcon,
  SearchIcon,
  SettingsIcon,
} from "@/primitives/Icon";
import { useAppDispatch, useAppState } from "@/state/AppState";
import type { ReactNode } from "react";

/**
 * 40px vertical rail on the right edge.
 *
 * Six icon buttons that summon the major panels: files, search,
 * connections, browser, git (todo), settings. Each shows its
 * keyboard shortcut on hover. The active panel's icon gets a
 * 2px steel-blue strip flush to the screen's right edge.
 *
 * Lives at the right edge — the project pill in the TopBar still
 * floats above it visually thanks to z-index ordering, but in the
 * column layout the rail anchors that side.
 */
export function ActivityRail() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  return (
    <aside
      style={{
        width: 40,
        flexShrink: 0,
        height: "100%",
        backgroundColor: "var(--surface-1)",
        borderLeft: "var(--border-1)",
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
        active={state.fileTreeVisible}
        label="Files"
        chord="⌘B"
        onClick={() => dispatch({ type: "toggle-file-tree" })}
      >
        <FolderIcon />
      </RailButton>

      <RailButton
        active={state.searchOpen}
        label="Search"
        chord="⌘⇧F"
        onClick={() => dispatch({ type: "toggle-search" })}
      >
        <SearchIcon />
      </RailButton>

      <RailButton
        active={state.connectionsVisible}
        label="Connections"
        chord="⌘⇧;"
        onClick={() => dispatch({ type: "toggle-connections" })}
      >
        <ConnectionsIcon />
      </RailButton>

      <RailButton
        active={state.browserVisible}
        label="Browser"
        chord="⌘⇧B"
        onClick={() => dispatch({ type: "toggle-browser" })}
      >
        <BrowserIcon />
      </RailButton>

      <div style={{ flex: 1 }} />

      <RailButton
        active={false}
        label="Git"
        chord="⌘G"
        onClick={() => {
          /* Git panel mounts inline in v2; for now this is a placeholder */
        }}
        disabled
      >
        <GitIcon />
      </RailButton>

      <RailButton
        active={state.apiKeyDialogOpen}
        label="Settings"
        chord=""
        onClick={() => dispatch({ type: "toggle-api-key" })}
      >
        <SettingsIcon />
      </RailButton>
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
