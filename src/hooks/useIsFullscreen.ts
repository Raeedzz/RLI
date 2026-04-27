import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Tracks whether the current Tauri window is in OS-level fullscreen.
 *
 * On macOS this lets us reclaim the 78px traffic-light gutter — the
 * close/min/max buttons are hidden in fullscreen so the tabs can slide
 * flush against the left edge.
 *
 * Listens to `onResized` because Tauri 2 fires it on fullscreen toggle
 * (the window's bounds change). Also re-checks on `tauri://focus` for
 * good measure — paranoia in case a future Tauri build changes which
 * events fire on the fullscreen transition.
 */
export function useIsFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;

    const refresh = () => {
      win
        .isFullscreen()
        .then((v) => {
          if (!cancelled) setIsFullscreen(v);
        })
        .catch(() => {});
    };

    refresh();

    const offResized = win.onResized(() => refresh());
    const offFocus = win.onFocusChanged(() => refresh());

    return () => {
      cancelled = true;
      void offResized.then((fn) => fn());
      void offFocus.then((fn) => fn());
    };
  }, []);

  return isFullscreen;
}
