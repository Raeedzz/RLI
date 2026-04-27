import { AppShell } from "@/shell/AppShell";
import { AppStateProvider } from "@/state/AppState";

/**
 * The default project's path in `INITIAL_STATE` is just a first-launch
 * placeholder. Once the user picks a real folder via ⌘O (or the project
 * pill's "open project…" item), all state — projects, sessions, layout,
 * open files — is persisted via `lib/persistence.ts` and re-hydrated on
 * the next launch by `AppStateProvider`.
 */
export function App() {
  return (
    <AppStateProvider>
      <AppShell />
    </AppStateProvider>
  );
}
