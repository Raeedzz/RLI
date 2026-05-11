import { useEffect } from "react";
import {
  useActiveProject,
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { openProjectDialog } from "@/lib/projectDialog";
import {
  nextAutoBranch,
  primaryTerminalTab,
  worktreeCreate,
} from "@/lib/worktrees";
import { projectSettings } from "@/state/types";

/**
 * Match a digit press regardless of modifier-induced char shifting.
 * ⌘1 produces e.key === "1", but ⌘⇧1 produces "!" on US keyboards —
 * so we read the physical Digit code instead.
 */
function digitKey(e: KeyboardEvent): number | null {
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}

/**
 * Global keyboard shortcuts. Worktree-centric since the v2 rewrite —
 * pane-tree chords (⌘B/⌘E/⌘T arrow) are gone with the recursive panes.
 *
 * The chord set:
 *   ⌘K / ⌘F      — search overlay
 *   ⌘O           — open project
 *   ⌘N           — new worktree (prompt for branch via sidebar UI)
 *   ⌘W           — close active tab
 *   ⌘1..9        — switch to nth worktree of active project
 *   ⌘⇧1..9       — switch to nth project
 *   ⌘⌥1..9       — same as ⌘⇧, kept for muscle memory
 *   ⌘B           — toggle sidebar
 *   ⌘\           — toggle right panel
 *   ⌘⇧F          — search overlay (alias)
 *   Esc          — close overlays
 */
export function useKeyboardShortcuts() {
  const dispatch = useAppDispatch();
  const project = useActiveProject();
  const worktree = useActiveWorktree();
  const state = useAppState();
  const { projectOrder, worktrees } = state;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      if (cmd && !shift && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "f")) {
        e.preventDefault();
        dispatch({ type: "set-search", open: true });
        return;
      }

      // ⌘, opens settings (macOS-standard).
      if (cmd && !shift && e.key === ",") {
        e.preventDefault();
        dispatch({ type: "toggle-settings" });
        return;
      }

      if (cmd && shift && e.key.toLowerCase() === "f") {
        e.preventDefault();
        dispatch({ type: "toggle-search" });
        return;
      }

      if (cmd && !shift && e.key.toLowerCase() === "b") {
        e.preventDefault();
        dispatch({ type: "toggle-sidebar" });
        return;
      }

      if (cmd && !shift && e.key === "\\") {
        e.preventDefault();
        dispatch({ type: "toggle-right-panel" });
        return;
      }

      if (cmd && !shift && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProjectDialog(dispatch);
        return;
      }

      // ⌘T — open a new terminal tab in the main column of the active
      // worktree. Each tab gets a fresh PTY id, named "shell" until the
      // first prompt sets a real title. The random suffix matters: two
      // ⌘T presses in the same millisecond would otherwise mint the
      // same tab id and the second one would overwrite the first in
      // the reducer's tabs map.
      if (cmd && !shift && e.key.toLowerCase() === "t" && worktree) {
        e.preventDefault();
        const stamp = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 8);
        const id = `t_${stamp}_${rand}`;
        const ptyId = `pty_${stamp}_${rand}`;
        dispatch({
          type: "open-tab",
          tab: {
            id,
            worktreeId: worktree.id,
            kind: "terminal",
            ptyId,
            detectedCli: null,
            agentStatus: "idle",
            title: "shell",
            summary: "ready",
            summaryUpdatedAt: Date.now(),
          },
        });
        return;
      }

      // ⌘N — auto-create a new worktree in the active project. No
      // prompt: the branch is named via the random landmark pool.
      if (cmd && !shift && e.key.toLowerCase() === "n" && project) {
        e.preventDefault();
        const branch = nextAutoBranch(project.id, state);
        const proj = project;
        const cfg = projectSettings(proj);
        void (async () => {
          try {
            const w = await worktreeCreate(
              proj.id,
              proj.path,
              branch,
              branch,
              {
                baseRef: cfg.baseBranch,
                filesToCopy: cfg.filesToCopy,
                setupScript: cfg.setupScript,
              },
            );
            dispatch({ type: "add-worktree", worktree: w });
            dispatch({ type: "open-tab", tab: primaryTerminalTab(w) });
          } catch (err) {
            window.alert(`Worktree creation failed: ${err}`);
          }
        })();
        return;
      }

      if (cmd && !shift && e.key.toLowerCase() === "w" && worktree?.activeTabId) {
        e.preventDefault();
        dispatch({ type: "close-tab", id: worktree.activeTabId });
        return;
      }

      // Project switch: ⌘⇧1..9 or ⌘⌥1..9
      if (cmd && (shift || e.altKey)) {
        const n = digitKey(e);
        if (n !== null) {
          e.preventDefault();
          const targetId = projectOrder[n - 1];
          if (targetId) {
            dispatch({ type: "set-active-project", id: targetId });
          }
          return;
        }
      }

      // Worktree switch: ⌘1..9 within active project
      if (cmd && !shift && !e.altKey) {
        const n = digitKey(e);
        if (n !== null && project) {
          e.preventDefault();
          const projectWorktrees = Object.values(worktrees).filter(
            (w) => w.projectId === project.id,
          );
          const target = projectWorktrees[n - 1];
          if (target) {
            dispatch({
              type: "set-active-worktree",
              projectId: project.id,
              worktreeId: target.id,
            });
          }
          return;
        }
      }

      if (e.key === "Escape") {
        dispatch({ type: "set-palette", open: false });
        dispatch({ type: "set-search", open: false });
        dispatch({ type: "set-settings-open", open: false });
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, project, worktree, worktrees, projectOrder, state]);
}
