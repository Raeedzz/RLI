import { WindowChrome } from "./WindowChrome";
import { SplitLayout } from "./SplitLayout";
import { StatusBar } from "./StatusBar";
import { ActivityRail } from "./ActivityRail";
import { SearchOverlay } from "@/palette/SearchOverlay";
import { ApiKeyDialog } from "@/onboarding/ApiKeyDialog";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSpatialNavigation } from "@/hooks/useSpatialNavigation";
import { useOpenUrlInBrowser } from "@/hooks/useOpenUrlInBrowser";

/**
 * Top-level frame:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ ●●●         [⌕  Search      ⌘⇧F]              [⚙]        │  chrome (28px)
 *   ├──┬──────────┬────────────────────────────────────────────┤
 *   │  │          │ [● tab] [tab] [+]      [project: RLI ▾]   │  tabs over workspace
 *   │AR│  left    │────────────────────────────────────────────│
 *   │  │  panel   │                                             │
 *   │  │          │   workspace                                │
 *   │  │          │                                             │
 *   ├──┴──────────┴────────────────────────────────────────────┤
 *   │ ● rli/branch · subtitle           ✻ Claude · ⌘K commands  │  status bar (24px)
 *   └──────────────────────────────────────────────────────────┘
 *
 * Activity rail and the left panel run full height from the chrome
 * down to the status bar. The session tabs only span the workspace
 * column on the right — that's how Cursor / VS Code arrange tabs so
 * they sit "above the file you're editing" rather than across the
 * whole window.
 */
export function AppShell() {
  useKeyboardShortcuts();
  useSpatialNavigation();
  useOpenUrlInBrowser();

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
      <WindowChrome />

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

      <SearchOverlay />
      <ApiKeyDialog />
    </div>
  );
}
