import { TopBar } from "./TopBar";
import { SplitLayout } from "./SplitLayout";
import { StatusBar } from "./StatusBar";
import { ActivityRail } from "./ActivityRail";
import { CommandPalette } from "@/palette/CommandPalette";
import { SearchOverlay } from "@/palette/SearchOverlay";
import { ApiKeyDialog } from "@/onboarding/ApiKeyDialog";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSessionSummary } from "@/hooks/useSessionSummary";
import { useActiveSession } from "@/state/AppState";

/**
 * Top-level frame:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ [● tab] [tab] [+]              project: RLI ▾              │  top bar (36px)
 *   ├──┬──────────────────────────────────────────────────────────┤
 *   │A │ [files | git | mcp]   workspace        [browser?]        │
 *   │R │  left panel           pane tree        right pane         │
 *   │  │                                        (when ⌘⇧B on)      │
 *   ├──┴──────────────────────────────────────────────────────────┤
 *   │ ● rli/branch · subtitle                ✻ Claude · ⌘K commands │  status bar (24px)
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Files / Git / Skills + MCP share a single left slot — clicking a
 * tab in the ActivityRail swaps which panel occupies the slot. Browser
 * lives as a right-side workspace pane, not an overlay.
 */
export function AppShell() {
  useKeyboardShortcuts();
  const session = useActiveSession();
  useSessionSummary(session?.id ?? null);

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
        <ActivityRail />

        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <SplitLayout />
        </div>
      </div>

      <StatusBar />

      <CommandPalette />
      <SearchOverlay />
      <ApiKeyDialog />
    </div>
  );
}
