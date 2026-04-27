import { TopBar } from "./TopBar";
import { SplitLayout } from "./SplitLayout";
import { StatusBar } from "./StatusBar";
import { CommandPalette } from "@/palette/CommandPalette";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

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

      <div style={{ flex: 1, minHeight: 0 }}>
        <SplitLayout />
      </div>

      <StatusBar />

      <CommandPalette />
    </div>
  );
}
