import { MotionConfig } from "motion/react";
import { AppShell } from "@/shell/AppShell";
import { AppStateProvider } from "@/state/AppState";
import { ToastProvider } from "@/primitives/Toast";

/**
 * The default project's path in `INITIAL_STATE` is a first-launch
 * placeholder. Once the user picks a real folder via ⌘O all state —
 * projects, worktrees, tabs, archived history — persists via
 * `lib/persistence.ts` and rehydrates on the next launch.
 *
 * MotionConfig with `reducedMotion="user"` lets motion's components
 * honor the macOS Accessibility "Reduce motion" setting at the API
 * level. The CSS rule in `tokens.css` covers everything that uses
 * native CSS transitions/animations.
 */
export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AppStateProvider>
        <ToastProvider>
          <AppShell />
        </ToastProvider>
      </AppStateProvider>
    </MotionConfig>
  );
}
