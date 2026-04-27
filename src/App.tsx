import { AppShell } from "@/shell/AppShell";
import { AppStateProvider } from "@/state/AppState";

export function App() {
  return (
    <AppStateProvider>
      <AppShell />
    </AppStateProvider>
  );
}
