import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Tracks whether *any* pane in the workspace is currently being dragged.
 *
 * Why this exists: WebKit (which Tauri ships on macOS) intentionally
 * hides custom-MIME `dataTransfer.types` during `dragover` for privacy.
 * That means a target pane can't reliably ask "is this my drag?" from
 * the event itself — it would see an empty types array and reject the
 * hover. So instead we set a global flag on `dragstart` and read it
 * on every target pane's `dragover`.
 *
 * It also lets each pane know to render a transparent "drop shield"
 * over its body content (xterm/CodeMirror/iframe) — those widgets have
 * their own drag handlers that can swallow events before they reach
 * our wrapper, so the shield captures drag events directly.
 */

interface PaneDragContextValue {
  isDragging: boolean;
  setDragging: (value: boolean) => void;
}

const PaneDragContext = createContext<PaneDragContextValue | null>(null);

export function PaneDragProvider({ children }: { children: ReactNode }) {
  const [isDragging, setDragging] = useState(false);

  // Belt-and-suspenders: even if a `dragend` listener is missed (e.g.
  // the user drops on something completely outside any pane), the
  // window-level `dragend` clears the flag so we don't get stuck in
  // a perma-shielded state.
  useEffect(() => {
    if (!isDragging) return;
    const clear = () => setDragging(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [isDragging]);

  const value = useMemo(
    () => ({ isDragging, setDragging }),
    [isDragging],
  );

  return (
    <PaneDragContext.Provider value={value}>
      {children}
    </PaneDragContext.Provider>
  );
}

export function usePaneDrag(): PaneDragContextValue {
  const ctx = useContext(PaneDragContext);
  // Provider not mounted (e.g. unit tests) — return a no-op shape so
  // PaneFrame still renders without crashing.
  return ctx ?? { isDragging: false, setDragging: () => {} };
}
