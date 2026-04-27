import { useEffect } from "react";
import {
  useActiveProject,
  useActiveSession,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { defaultWorkspaceWithEditor } from "@/state/paneTree";
import { openProjectDialog } from "@/lib/projectDialog";

/**
 * Match a number-row digit press regardless of modifier-induced char
 * shifting. ⌘1 produces e.key === "1", but ⌘⇧1 produces "!" on a US
 * keyboard — so we read the physical key code instead. Returns 1..9
 * for Digit1..Digit9, otherwise null.
 */
function digitKey(e: KeyboardEvent): number | null {
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}

/**
 * Global keyboard shortcuts (v1, fixed). Per CONTEXT.md the keymap is
 * not remappable in v1. New chords are added here as features land.
 *
 * Most chords route into dispatch actions; some are stubs that will
 * route into feature-specific hooks once the matching task fully wires
 * its panel.
 */
export function useKeyboardShortcuts() {
  const dispatch = useAppDispatch();
  const project = useActiveProject();
  const session = useActiveSession();
  const { sessions, projects } = useAppState();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      // Always-handled chords
      if (cmd && !shift && e.key.toLowerCase() === "k") {
        e.preventDefault();
        dispatch({ type: "toggle-palette" });
        return;
      }
      if (cmd && !shift && e.key.toLowerCase() === "b") {
        e.preventDefault();
        dispatch({ type: "toggle-left-panel", panel: "files" });
        return;
      }
      // ⌃⇧G — source-control panel (matches VS Code muscle memory)
      if (e.ctrlKey && shift && e.key.toLowerCase() === "g") {
        e.preventDefault();
        dispatch({ type: "toggle-left-panel", panel: "git" });
        return;
      }
      if (cmd && shift && e.key === ":") {
        // ⌘⇧; produces ":" with shift on US keyboards
        e.preventDefault();
        dispatch({ type: "toggle-left-panel", panel: "connections" });
        return;
      }
      if (cmd && shift && e.key.toLowerCase() === "f") {
        e.preventDefault();
        dispatch({ type: "toggle-search" });
        return;
      }
      if (cmd && shift && e.key.toLowerCase() === "b") {
        e.preventDefault();
        dispatch({ type: "toggle-browser" });
        return;
      }

      // ⌘N — new session in active project
      if (cmd && !shift && e.key.toLowerCase() === "n" && project) {
        e.preventDefault();
        const n =
          sessions.filter((s) => s.projectId === project.id).length + 1;
        dispatch({
          type: "add-session",
          session: {
            id: `s_${Date.now().toString(36)}`,
            projectId: project.id,
            name: `session ${n}`,
            subtitle: "ready",
            branch: `rli/session-${n}`,
            status: "idle",
            createdAt: Date.now(),
            workspace: defaultWorkspaceWithEditor(),
            openFile: null,
          },
        });
        return;
      }

      // ⌘W — close active session
      if (cmd && !shift && e.key.toLowerCase() === "w" && session) {
        e.preventDefault();
        dispatch({ type: "remove-session", id: session.id });
        return;
      }

      // ⌘1..⌘9 — switch to nth session in the active project.
      // ⌘⇧1..⌘⇧9 — switch to nth project in the projects array.
      // Both read the physical Digit code so Shift's "1 → !" remap on
      // US keyboards doesn't drop the shifted variant.
      const n = cmd ? digitKey(e) : null;
      if (n !== null) {
        if (shift) {
          const target = projects[n - 1];
          if (target) {
            e.preventDefault();
            dispatch({ type: "set-active-project", id: target.id });
          }
          return;
        }
        if (project) {
          const projectSessions = sessions.filter(
            (s) => s.projectId === project.id,
          );
          const target = projectSessions[n - 1];
          if (target) {
            e.preventDefault();
            dispatch({
              type: "set-active-session",
              projectId: project.id,
              sessionId: target.id,
            });
          }
          return;
        }
      }

      // ⌘O — open folder as a project
      if (cmd && !shift && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProjectDialog(dispatch);
        return;
      }
      // ⌘⇧O — same dialog, mirrored for muscle memory
      // (left out intentionally to keep the chord set tight)

      if (e.key === "Escape") {
        // Pane-managed Esc handlers run first via their own listeners.
        // This catches Esc when focus is elsewhere — close transient
        // overlays. The persistent left panel (files/git/connections)
        // stays put on Esc so it doesn't disappear out from under you.
        dispatch({ type: "set-palette", open: false });
        dispatch({ type: "set-search", open: false });
        return;
      }

      // Stubs — wired by their owning tasks
      // ⌘L → highlight-and-ask (Task #7 — handled inside CodeMirror)
      // ⌘⏎ → commit-with-AI (Task #8 — handled inside git panel)
      // ⌘⇧⏎ → push (Task #8)
      // ⌘\ split right
      // ⌘⇧\ split down
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, project, session, sessions, projects]);
}

