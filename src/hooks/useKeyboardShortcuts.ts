import { useEffect, useRef } from "react";
import {
  useActiveProject,
  useActiveSession,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { defaultWorkspaceWithEditor, leaves } from "@/state/paneTree";
import type { PaneContent, SplitDirection } from "@/state/types";
import { openProjectDialog } from "@/lib/projectDialog";
import { forgetSession } from "@/terminal/sessionMemory";

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
 * How long the user has, after pressing ⌘B / ⌘E / ⌘T, to follow up
 * with an arrow before the chord expires. Long enough for a deliberate
 * two-key sequence, short enough that a stray prefix doesn't sit around
 * eating later keypresses.
 */
const CHORD_PENDING_MS = 1500;

const CHORD_CONTENT: Record<string, PaneContent> = {
  b: "browser",
  e: "editor",
  t: "terminal",
};

const ARROW_DIRECTION: Record<string, SplitDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

type PendingChord = { kind: "split-pane"; content: PaneContent; timer: number };
type ChordSpec = { kind: "split-pane"; content: PaneContent };

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

  // Currently-armed chord. Set when ⌘B/⌘E/⌘T or ⌘` is pressed; cleared
  // when the follow-up key consumes it, the timer expires, or any other
  // key breaks the sequence. A ref (not state) so the keydown handler
  // reads the latest value synchronously without needing to re-bind.
  const pendingChordRef = useRef<PendingChord | null>(null);

  useEffect(() => {
    const clearChord = () => {
      const pending = pendingChordRef.current;
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pendingChordRef.current = null;
    };

    const armChord = (chord: ChordSpec) => {
      clearChord();
      const timer = window.setTimeout(() => {
        pendingChordRef.current = null;
      }, CHORD_PENDING_MS);
      pendingChordRef.current = { ...chord, timer };
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      // Resolve a pending split-pane chord first. ⌘B/⌘E/⌘T arms the
      // chord; an arrow that follows decides direction. Holding Cmd
      // through the arrow is fine; we accept either.
      const pending = pendingChordRef.current;
      if (pending) {
        const direction = ARROW_DIRECTION[e.key];
        if (direction) {
          e.preventDefault();
          const { content } = pending;
          clearChord();
          if (session) {
            const allLeaves = leaves(session.workspace);
            const target = allLeaves[allLeaves.length - 1];
            if (target) {
              dispatch({
                type: "split-pane",
                sessionId: session.id,
                paneId: target.id,
                direction,
                content,
              });
            }
          }
          return;
        }
        // Any other keypress cancels the chord. Modifier-only events
        // (just ⌘, ⇧, ⌃) don't count — those keep the chord armed so
        // the user can still tap the follow-up arrow.
        if (e.key !== "Meta" && e.key !== "Control" && e.key !== "Shift") {
          clearChord();
        }
      }

      // Always-handled chords
      if (cmd && !shift && e.key.toLowerCase() === "k") {
        e.preventDefault();
        dispatch({ type: "toggle-palette" });
        return;
      }

      // ⌘B / ⌘E / ⌘T — chord prefix. Each arms a pending split for the
      // matching content type; the arrow that follows decides direction.
      if (cmd && !shift) {
        const k = e.key.toLowerCase();
        const content = CHORD_CONTENT[k];
        if (content) {
          e.preventDefault();
          armChord({ kind: "split-pane", content });
          return;
        }
      }

      // ⌘⌥1..9 — jump directly to the nth project. Reads the physical
      // Digit code so macOS's alt-induced char shifting (⌥1 → ¡, etc.)
      // doesn't drop the press. Sits before the ⌘1..9 session switcher
      // below so the alt-modified version wins.
      if (cmd && e.altKey && !shift) {
        const projectIdx = digitKey(e);
        if (projectIdx !== null) {
          e.preventDefault();
          const target = projects[projectIdx - 1];
          if (target) {
            dispatch({ type: "set-active-project", id: target.id });
          }
          return;
        }
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
        forgetSession(session.id);
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
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const pending = pendingChordRef.current;
      if (pending) {
        window.clearTimeout(pending.timer);
        pendingChordRef.current = null;
      }
    };
  }, [dispatch, project, session, sessions, projects]);
}

