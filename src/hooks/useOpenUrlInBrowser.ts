import { useEffect } from "react";
import { browser } from "@/lib/browser";

/**
 * Catches the `rli:open-url` custom event dispatched from terminal cells
 * and routes the URL into the in-house browser daemon. The browser
 * pane (if any is mounted) will pick up the navigation through its own
 * health watcher; we just kick the daemon eagerly.
 */
export function useOpenUrlInBrowser() {
  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent<{ url: string }>).detail?.url;
      if (!url) return;
      void browser.navigate(url).catch(() => {
        /* daemon may not be up; ignore */
      });
    };
    window.addEventListener("rli:open-url", onOpen);
    return () => window.removeEventListener("rli:open-url", onOpen);
  }, []);
}
