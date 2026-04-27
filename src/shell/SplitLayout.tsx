import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Pane } from "./Pane";
import { useActiveSession, useAppState } from "@/state/AppState";

/**
 * Workspace layout — Warp-minimal default.
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │                                                        │
 *   │   agent terminal (full pane)                           │
 *   │                                                        │
 *   └────────────────────────────────────────────────────────┘
 *
 * No file tree, no editor, no user terminal by default. Splits are
 * user-invoked:
 *   ⌘\   → split right (adds a user terminal pane)
 *   ⌘⇧\  → split down (adds an editor pane)
 *   ⌘B   → toggle file tree (slides in as a left panel inside the workspace)
 *
 * For v1 visual scaffold we render the single agent pane plus a thin
 * "split" indicator if any split state exists. PTY content lands in Task #6.
 */
export function SplitLayout() {
  const session = useActiveSession();
  const { fileTreeVisible } = useAppState();

  return (
    <PanelGroup direction="horizontal" autoSaveId="rli-workspace">
      {fileTreeVisible && (
        <>
          <Panel defaultSize={18} minSize={12} maxSize={30} order={1} collapsible>
            <Pane surface="1">
              <PaneStub label="file tree · Task #15" />
            </Pane>
          </Panel>
          <PanelResizeHandle />
        </>
      )}

      <Panel defaultSize={100} minSize={40} order={2}>
        <Pane surface="0">
          {session ? (
            <PaneStub label={`agent terminal · ${session.name} · Task #6`} />
          ) : (
            <PaneStub label="no active session" />
          )}
        </Pane>
      </Panel>
    </PanelGroup>
  );
}

function PaneStub({ label }: { label: string }) {
  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--text-tertiary)",
        userSelect: "none",
      }}
    >
      {label}
    </div>
  );
}
