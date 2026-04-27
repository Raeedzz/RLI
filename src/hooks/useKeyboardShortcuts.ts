import { useEffect } from "react";
import { useAppDispatch } from "@/state/AppState";

/**
 * Global keyboard shortcuts (v1, fixed). Per CONTEXT.md the keymap is not
 * remappable in v1. New chords are added here as features land.
 *
 * Most chords route into dispatch actions; some are stubs that route into
 * feature-specific hooks once those tasks complete.
 */
export function useKeyboardShortcuts() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Detect the platform "command" key. macOS = metaKey; we are macOS-only v1
      // but keep the cross-platform check for future cross-platform work.
      const cmd = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

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

      if (e.key === "Escape") {
        // Palette manages its own Escape internally when focused;
        // this catches Escape when focus is elsewhere.
        dispatch({ type: "set-palette", open: false });
        return;
      }

      // Stubs — wired up by their owning tasks
      // ⌘N → new session (Task #9)
      // ⌘W → close session (Task #9)
      // ⌘O → open project (Task #16)
      // ⌘⇧F → search (Task #15)
      // ⌘⇧; → connections (Task #10)
      // ⌘⇧B → browser pane (Task #14)
      // ⌘L → highlight-and-ask (Task #7 — needs editor focus)
      // ⌘⏎ → commit-with-AI (Task #8)
      // ⌘⇧⏎ → push (Task #8)
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);
}
