import { useEffect, useRef } from "react";
import { useAppState } from "@/state/AppState";
import { focusTerminal } from "@/terminal/terminalFocusRegistry";

/**
 * Sends keyboard focus to the primary terminal of the active worktree
 * whenever that worktree changes (including initial mount). Mounted
 * once at the AppShell top level — fires off a state subscription, not
 * a DOM listener, so it picks up every reducer path that lands on
 * `set-active-worktree` regardless of who dispatched it (sidebar
 * click, Cmd+digit, restore-worktree, etc.).
 *
 * The user's complaint: switching worktrees would leave focus on
 * whichever secondary control they were last interacting with (a
 * helper terminal, the URL bar, a Files browser row), so the next
 * keystroke didn't land in the main terminal. This hook restores the
 * Warp-style invariant — the primary terminal is always armed and
 * ready as soon as you arrive at a worktree.
 *
 * Retry strategy: a worktree switch can race the BlockTerminal mount
 * for that worktree's primary tab — when the user clicks a sidebar
 * row, the reducer updates and the hook fires immediately, but the
 * new BlockTerminal might still be running its first useEffect and
 * hasn't called `registerTerminalFocus` yet. We try in three places:
 *   1. Synchronously (covers the already-mounted case, the most
 *      common one once worktrees are warm).
 *   2. On the next microtask via Promise.resolve() (catches mounts
 *      that finished their effect in the same task).
 *   3. On the next animation frame (catches mounts that needed a
 *      paint, e.g. when switching to a worktree that's never been
 *      visited and is just now mounting all its terminals).
 *
 * Secondary terminals are deliberately not touched: the user explicitly
 * opted into a secondary by clicking it; we shouldn't fight that.
 */
export function useFocusActiveTerminal() {
  const state = useAppState();
  const activeProjectId = state.activeProjectId;
  const activeWorktreeId = activeProjectId
    ? (state.activeWorktreeByProject[activeProjectId] ?? null)
    : null;
  const worktree = activeWorktreeId
    ? (state.worktrees[activeWorktreeId] ?? null)
    : null;
  const primaryTabId = worktree?.tabIds[0] ?? null;

  // Last successfully-focused tab id. Used to avoid refocusing on
  // every render — only when the resolved primary tab actually changes.
  const lastFocusedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!primaryTabId) return;
    if (lastFocusedRef.current === primaryTabId) return;

    const attempt = (): boolean => {
      const ok = focusTerminal(primaryTabId);
      if (ok) lastFocusedRef.current = primaryTabId;
      return ok;
    };

    if (attempt()) return;

    // The BlockTerminal might be mid-mount; let its useEffect run.
    let rafId = 0;
    const microtaskHandle = Promise.resolve().then(() => {
      if (attempt()) return;
      rafId = requestAnimationFrame(() => {
        // Final shot — if it still hasn't registered after a frame,
        // the user is doing something exotic (worktree with no
        // primary terminal yet) and we let it slide. They can click
        // the terminal manually; the next dispatch will retry.
        attempt();
      });
    });
    void microtaskHandle;

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [primaryTabId]);
}
