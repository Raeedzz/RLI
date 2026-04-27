import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useActiveProject,
  useActiveSession,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";

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
  const { sessions } = useAppState();

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
        dispatch({ type: "toggle-file-tree" });
        return;
      }
      if (cmd && shift && e.key === ":") {
        // ⌘⇧; produces ":" with shift on US keyboards
        e.preventDefault();
        dispatch({ type: "toggle-connections" });
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

      // ⌘1..⌘9 — switch to nth session in the active project
      if (cmd && !shift && project && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const projectSessions = sessions.filter(
          (s) => s.projectId === project.id,
        );
        const target = projectSessions[idx];
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

      // ⌘O — open folder as a project
      if (cmd && !shift && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProjectDialog(dispatch);
        return;
      }

      if (e.key === "Escape") {
        // Pane-managed Esc handlers run first via their own listeners.
        // This catches Esc when focus is elsewhere — close all overlays.
        dispatch({ type: "set-palette", open: false });
        dispatch({ type: "set-search", open: false });
        dispatch({ type: "set-connections", visible: false });
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
  }, [dispatch, project, session, sessions]);
}

async function openProjectDialog(
  dispatch: ReturnType<typeof useAppDispatch>,
): Promise<void> {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open project",
    });
    if (typeof selected !== "string") return;
    const path = selected;
    const name = path.split("/").filter(Boolean).pop() ?? path;
    const glyph = name.charAt(0).toUpperCase();
    const id = `p_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}_${Date.now().toString(36)}`;
    dispatch({
      type: "add-project",
      project: {
        id,
        path,
        name,
        glyph,
        pinned: false,
      },
    });
  } catch {
    // User cancelled or dialog plugin unavailable
  }
}
