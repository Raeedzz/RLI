import { WindowChrome } from "./WindowChrome";
import { Sidebar } from "./Sidebar";
import { MainColumn } from "./MainColumn";
import { RightPanel } from "./RightPanel";
import { CreatePRDialog } from "./CreatePRDialog";
import { SettingsView } from "./SettingsView";
import { SearchOverlay } from "@/palette/SearchOverlay";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSpatialNavigation } from "@/hooks/useSpatialNavigation";
import { useOpenUrlInBrowser } from "@/hooks/useOpenUrlInBrowser";
import { useAppState } from "@/state/AppState";

/**
 * Three-column shell:
 *
 *   ┌──────┬─────────────────────────┬───────────────┐
 *   │      │                         │               │
 *   │ side │  main column            │  right panel  │
 *   │      │  (tabs + content +      │  (files /     │
 *   │      │   chatbox)              │   changes /   │
 *   │      │                         │   checks /    │
 *   │      │                         │   memory)     │
 *   │      │                         │  ───────────  │
 *   │      │                         │  setup / run /│
 *   │      │                         │  terminal     │
 *   └──────┴─────────────────────────┴───────────────┘
 *
 * Sidebar collapses to a 40px icon rail (the toggle stays clickable);
 * right panel collapses fully to 0 width. Both via the `--sidebar-w` /
 * `--right-w` CSS vars driven from state. WindowChrome sits above as a
 * 28px traffic-light strip.
 */
export function AppShell() {
  useKeyboardShortcuts();
  useSpatialNavigation();
  useOpenUrlInBrowser();
  const { sidebarCollapsed, rightPanelCollapsed } = useAppState();

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
        overflow: "hidden",
        ["--sidebar-w" as string]: sidebarCollapsed
          ? "40px"
          : "var(--sidebar-width)",
        ["--right-w" as string]: rightPanelCollapsed
          ? "0px"
          : "var(--right-width)",
      }}
    >
      <WindowChrome />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "var(--sidebar-w) 1fr var(--right-w)",
          transition:
            "grid-template-columns var(--motion-base) var(--ease-out-quart)",
        }}
      >
        <aside
          style={{
            minWidth: 0,
            overflow: "hidden",
            backgroundColor: "var(--surface-1)",
            borderRight: "var(--border-1)",
          }}
        >
          <Sidebar />
        </aside>

        <main style={{ minWidth: 0, overflow: "hidden" }}>
          <MainColumn />
        </main>

        <aside
          style={{
            minWidth: 0,
            overflow: "hidden",
            backgroundColor: "var(--surface-1)",
            borderLeft: "var(--border-1)",
          }}
        >
          <RightPanel />
        </aside>
      </div>

      <SearchOverlay />
      <CreatePRDialog />
      <SettingsView />
    </div>
  );
}
