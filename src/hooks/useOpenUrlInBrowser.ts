import { useEffect } from "react";
import { useActiveSession, useAppDispatch } from "@/state/AppState";
import { leaves } from "@/state/paneTree";
import { browser } from "@/lib/browser";

/**
 * Catches the `rli:open-url` custom event dispatched from terminal cells
 * and routes the URL into the in-app browser pane:
 *
 *   - if the active session already has a `browser` leaf in its
 *     workspace tree, just navigate it
 *   - otherwise split the rightmost leaf to add a `browser` pane,
 *     and after the split commits, navigate the daemon
 *
 * Goal: keep links inside the CLI (Gstack-style) instead of bouncing
 * to the user's macOS default browser via `open`.
 */
export function useOpenUrlInBrowser() {
  const session = useActiveSession();
  const dispatch = useAppDispatch();

  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent<{ url: string }>).detail?.url;
      if (!url || !session) return;
      const allLeaves = leaves(session.workspace);
      const hasBrowser = allLeaves.some((l) => l.content === "browser");
      if (hasBrowser) {
        // BrowserPane(s) listening on the workspace already; just
        // tell the daemon to navigate.
        void browser.navigate(url);
        return;
      }
      const last = allLeaves[allLeaves.length - 1];
      if (!last) return;
      dispatch({
        type: "split-pane",
        sessionId: session.id,
        paneId: last.id,
        direction: "right",
        content: "browser",
      });
      // The newly mounted BrowserPane polls health and navigates on
      // its own once the daemon answers. We still kick the daemon
      // explicitly in case it was already up — harmless if it wasn't,
      // since the BrowserPane's own `initialUrl`/health-watcher would
      // pick it up. Tiny delay so the new pane mounts first.
      window.setTimeout(() => {
        void browser.navigate(url).catch(() => {
          /* daemon not up yet — BrowserPane will retry */
        });
      }, 100);
    };
    window.addEventListener("rli:open-url", onOpen);
    return () => window.removeEventListener("rli:open-url", onOpen);
  }, [dispatch, session]);
}
