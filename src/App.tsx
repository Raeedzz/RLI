import { useEffect } from "react";
import { AppShell } from "@/shell/AppShell";
import {
  AppStateProvider,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { fs } from "@/lib/fs";

export function App() {
  return (
    <AppStateProvider>
      <CwdSyncer />
      <AppShell />
    </AppStateProvider>
  );
}

/**
 * On first mount, resolve the actual working directory and update the
 * default project to point at it. Skipped (silently) if the Tauri
 * command isn't available (e.g. running vite-only).
 */
function CwdSyncer() {
  const dispatch = useAppDispatch();
  const state = useAppState();

  useEffect(() => {
    let cancelled = false;
    fs.cwd()
      .then((path) => {
        if (cancelled) return;
        const def = state.projects.find((p) => p.id === "p_default");
        if (!def) return;
        if (def.path === path) return;
        const name = path.split("/").filter(Boolean).pop() ?? path;
        dispatch({
          type: "add-project",
          project: {
            ...def,
            path,
            name,
            glyph: name.charAt(0).toUpperCase(),
          },
        });
      })
      .catch(() => {
        /* not running under Tauri or cwd unavailable */
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
