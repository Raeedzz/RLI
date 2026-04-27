import { AnimatePresence } from "motion/react";
import { TopBar } from "./TopBar";
import { SplitLayout } from "./SplitLayout";
import { StatusBar } from "./StatusBar";
import { ActivityRail } from "./ActivityRail";
import { CommandPalette } from "@/palette/CommandPalette";
import { SearchOverlay } from "@/palette/SearchOverlay";
import { ConnectionsView } from "@/connections/ConnectionsView";
import { BrowserPane } from "@/browser/BrowserPane";
import { ApiKeyDialog } from "@/onboarding/ApiKeyDialog";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSessionSummary } from "@/hooks/useSessionSummary";
import {
  useActiveSession,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";

/**
 * Top-level frame:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ [● tab] [tab] [+]              project: RLI ▾              │  top bar (36px)
 *   ├─────────────────────────────────────────────────────────────┤
 *   │                                                             │
 *   │   workspace (single agent terminal default)                │
 *   │                                                             │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ ● rli/branch · subtitle                          ⌘K commands │  status bar (24px)
 *   └─────────────────────────────────────────────────────────────┘
 *
 * No left sidebar. ⌘K palette renders above everything.
 */
export function AppShell() {
  useKeyboardShortcuts();
  const session = useActiveSession();
  useSessionSummary(session?.id ?? null);
  const { connectionsVisible, browserVisible } = useAppState();
  const dispatch = useAppDispatch();

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-1)",
        overflow: "hidden",
      }}
    >
      <TopBar />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          position: "relative",
        }}
      >
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <SplitLayout />

          <AnimatePresence>
            {connectionsVisible && (
              <ConnectionsView
                onClose={() =>
                  dispatch({ type: "set-connections", visible: false })
                }
              />
            )}
            {browserVisible && (
              <BrowserPane
                onClose={() =>
                  dispatch({ type: "set-browser", visible: false })
                }
              />
            )}
          </AnimatePresence>
        </div>

        <ActivityRail />
      </div>

      <StatusBar />

      <CommandPalette />
      <SearchOverlay />
      <ApiKeyDialog />
    </div>
  );
}
