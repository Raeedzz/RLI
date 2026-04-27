import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
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
 *
 * Why we expose both a ref and state: HTML5 D&D requires `dragover` to
 * call `preventDefault()` synchronously to keep the drop alive. React
 * state from context only flips after a re-render commits — by then,
 * the very first few `dragover` events have already passed and missed
 * their `preventDefault` window, so the browser silently refuses to
 * fire `drop` at all. The ref is updated synchronously in `setDragging`
 * so neighbor panes' `dragover` handlers can read it on the very next
 * tick, no matter what React's reconciler is doing.
 */

interface PaneDragContextValue {
  isDragging: boolean;
  /**
   * Mutable handle that mirrors `isDragging` but is updated
   * synchronously so `dragover` can read it before React commits the
   * matching state transition.
   */
  draggingRef: RefObject<boolean>;
  setDragging: (value: boolean) => void;
}

const PaneDragContext = createContext<PaneDragContextValue | null>(null);

export function PaneDragProvider({ children }: { children: ReactNode }) {
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);

  const setDragging = useCallback((value: boolean) => {
    draggingRef.current = value;
    setIsDragging(value);
  }, []);

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
  }, [isDragging, setDragging]);

  const value = useMemo(
    () => ({ isDragging, draggingRef, setDragging }),
    [isDragging, setDragging],
  );

  return (
    <PaneDragContext.Provider value={value}>
      {children}
    </PaneDragContext.Provider>
  );
}

export function usePaneDrag(): PaneDragContextValue {
  const ctx = useContext(PaneDragContext);
  if (ctx) return ctx;
  // Provider not mounted (e.g. unit tests) — return a no-op shape so
  // PaneFrame still renders without crashing. Constant ref so the
  // shape is stable across renders.
  return FALLBACK;
}

const FALLBACK_REF: RefObject<boolean> = { current: false };
const FALLBACK: PaneDragContextValue = {
  isDragging: false,
  draggingRef: FALLBACK_REF,
  setDragging: () => {},
};
