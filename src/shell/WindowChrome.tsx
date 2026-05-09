import { SearchIcon } from "@/primitives/Icon";
import { IconPullRequest } from "@/design/icons";
import { useIsFullscreen } from "@/hooks/useIsFullscreen";
import { useActiveWorktree, useAppDispatch } from "@/state/AppState";

const TRAFFIC_LIGHT_GUTTER = 78;
const HEIGHT = 28;

/**
 * Thin window-chrome strip pinned to the very top of the app.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ [● ●  ●]      [   ⌕ search…              ]         [⚙]  │  28px
 *   ├──────────────────────────────────────────────────────────┤
 *   │ [● tab] [tab] [+]               [project: RLI ▾]         │  tabs
 *   └──────────────────────────────────────────────────────────┘
 *
 * Houses what used to live in the tabs row alongside the macOS
 * traffic-light cluster: the search summoner (used to live in the
 * activity rail) and the settings gear. The traffic lights overlay
 * the top-left of this strip via Tauri's overlay-titlebar mode — we
 * just leave a 78px gutter for them when not in fullscreen.
 *
 * The whole strip is a Tauri drag region so the user can grab any
 * empty area to move the window. Children that should stay clickable
 * opt out via `data-tauri-drag-region={false}` on themselves.
 */
export function WindowChrome() {
  const dispatch = useAppDispatch();
  const isFullscreen = useIsFullscreen();
  const worktree = useActiveWorktree();

  return (
    <div
      data-tauri-drag-region
      style={{
        position: "relative",
        height: HEIGHT,
        flexShrink: 0,
        backgroundColor: "var(--surface-2)",
        borderBottom: "var(--border-1)",
        paddingLeft: isFullscreen ? "var(--space-2)" : TRAFFIC_LIGHT_GUTTER,
        paddingRight: "var(--space-2)",
        userSelect: "none",
        transition:
          "padding-left var(--motion-fast) var(--ease-out-quart)",
      }}
    >
      {/* Search input — centered horizontally AND vertically in the
          chrome strip. Absolute positioning + translate(-50%, -50%) keeps
          the trigger optically dead-center regardless of the right-side
          settings cluster's width. The wrapper is itself a drag region
          so its transparent margin doesn't block window dragging (Tauri
          reads the attribute off the click target, not its ancestors). */}
      <div
        data-tauri-drag-region
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          display: "flex",
          alignItems: "center",
          lineHeight: 0,
        }}
      >
        <SearchTrigger
          onOpen={() => dispatch({ type: "set-search", open: true })}
        />
      </div>

      {/* Right-anchored Create-PR button — opens the PR dialog for the
          active worktree. Disabled when no worktree is selected. */}
      <div
        data-tauri-drag-region
        style={{
          position: "absolute",
          top: "50%",
          right: "var(--space-2)",
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
        }}
      >
        <CreatePRButton
          disabled={!worktree}
          onClick={() => {
            if (!worktree) return;
            dispatch({ type: "set-pr-dialog", worktreeId: worktree.id });
          }}
        />
      </div>
    </div>
  );
}

function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-tauri-drag-region={false}
      title="Search  ⌘K"
      aria-label="Search"
      style={{
        width: 360,
        maxWidth: "50vw",
        height: 22,
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0 10px",
        backgroundColor: "var(--surface-1)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-sm)",
        cursor: "text",
        textAlign: "left",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), border-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-0)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-1)";
      }}
    >
      <span
        style={{
          color: "var(--text-tertiary)",
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <SearchIcon size={13} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xs)",
          color: "var(--text-tertiary)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        Search
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-disabled)",
          flexShrink: 0,
        }}
      >
        ⌘K
      </span>
    </button>
  );
}

function CreatePRButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-tauri-drag-region={false}
      disabled={disabled}
      title="Create pull request"
      aria-label="Create pull request"
      style={{
        height: 22,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px",
        backgroundColor: disabled
          ? "var(--surface-1)"
          : "var(--surface-accent-tinted)",
        color: disabled ? "var(--text-disabled)" : "var(--text-primary)",
        border: disabled
          ? "var(--border-1)"
          : "1px solid var(--accent-muted)",
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-tight)",
        cursor: disabled ? "default" : "pointer",
        flexShrink: 0,
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), border-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor =
          "color-mix(in oklch, var(--surface-accent-tinted), var(--accent) 8%)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor =
          "var(--surface-accent-tinted)";
      }}
    >
      <IconPullRequest size={12} />
      <span>Create PR</span>
    </button>
  );
}
