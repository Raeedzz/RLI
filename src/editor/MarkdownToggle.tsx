import { useAppDispatch, useAppState } from "@/state/AppState";

/**
 * Inline Rich / Source segmented toggle that slots into the editor
 * pane's header (via `PaneFrame`'s `headerActions` prop). Only rendered
 * by `WorkspaceLayout` when the pane is showing a markdown file, so it
 * never appears next to a regular .ts / .py / .rs editor.
 *
 * State lives at the app level (`markdownView`) so the user's
 * preference persists across file switches.
 */
export function MarkdownToggle() {
  const { markdownView } = useAppState();
  const dispatch = useAppDispatch();
  return (
    <div
      role="tablist"
      aria-label="Markdown view"
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        height: 20,
        backgroundColor: "var(--surface-2)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <ToggleButton
        label="Rich"
        active={markdownView === "rich"}
        onClick={() => dispatch({ type: "set-markdown-view", view: "rich" })}
      />
      <ToggleButton
        label="Source"
        active={markdownView === "source"}
        onClick={() => dispatch({ type: "set-markdown-view", view: "source" })}
      />
    </div>
  );
}

function ToggleButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        // Equal-width pills, both labels optically centred. Buttons
        // butt up against each other with no inter-pill gap — the
        // active surface-3 fill is the visual separator.
        minWidth: 56,
        height: "100%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 var(--space-2)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: active ? "var(--weight-medium)" : "var(--weight-regular)",
        letterSpacing: "var(--tracking-tight)",
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        cursor: "default",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = "var(--text-secondary)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      {label}
    </button>
  );
}
