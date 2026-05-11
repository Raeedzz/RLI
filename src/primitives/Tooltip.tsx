import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";

/**
 * Shared tooltip primitive — used by sidebar icon buttons and by the
 * main-column tab strip. Two pieces:
 *
 *   useTooltipAnchor() — manages the 400ms hover-intent timer and the
 *     one-shot DOMRect snapshot used to position the floating label.
 *     Hand `ref` to whatever element should trigger the tip; wire
 *     `beginShow` / `cancelShow` into its enter/leave/click handlers.
 *     `anchor` is non-null whenever the tooltip should be visible.
 *
 *   <Tooltip> — the floating label itself. Portaled to <body> so it
 *     escapes ancestor scroll/clip contexts. Positions itself via a
 *     measure-then-place pass so sidebar-edge buttons and bottom-of-
 *     viewport buttons (settings gear) don't render off-screen.
 */

export function useTooltipAnchor<T extends HTMLElement>(
  // 400ms intent delay: long enough to suppress incidental sweeps,
  // short enough that a deliberate hover feels responsive.
  delayMs = 400,
) {
  const ref = useRef<T>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const showTimerRef = useRef<number | null>(null);

  const beginShow = () => {
    if (anchor || showTimerRef.current) return;
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      if (ref.current) {
        setAnchor(ref.current.getBoundingClientRect());
      }
    }, delayMs);
  };

  const cancelShow = () => {
    if (showTimerRef.current) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    setAnchor(null);
  };

  useEffect(() => {
    return () => {
      if (showTimerRef.current) window.clearTimeout(showTimerRef.current);
    };
  }, []);

  return { ref, anchor, beginShow, cancelShow };
}

/**
 * Tooltip rendered into a portal at <body>, positioned relative to
 * the supplied DOMRect anchor. Render alongside `<AnimatePresence>`
 * so it can animate in/out:
 *
 *   <AnimatePresence>
 *     {anchor && <Tooltip label="Open file" anchor={anchor} />}
 *   </AnimatePresence>
 *
 * Placement is decided after the first render so we can use real
 * measured dimensions instead of guessing — without that, an icon
 * button against the sidebar's left edge ends up with its tip
 * snapped well to the right of the cursor, and a button at the
 * bottom of the rail (settings gear) ends up with its tip painted
 * below the visible viewport.
 *
 * Vertical preference: below the trigger; flips above when there
 * isn't room. Horizontal preference: left-aligned to trigger; flips
 * right-aligned when overflow would clip the right edge. Both axes
 * floor at an 8px safe margin so pathological cases never paint
 * past the viewport edge.
 *
 * `maxWidth` defaults to 240px but can be overridden — for tab
 * summary lines (~60ch) it's bumped up so the full live activity
 * string fits without ellipsis.
 */
export function Tooltip({
  label,
  anchor,
  maxWidth = 240,
  placement = "below",
}: {
  label: string;
  anchor: DOMRect;
  maxWidth?: number;
  /**
   * Vertical preference. `below` is the default for icon buttons
   * (sidebar) and `above` is preferred for elements that sit at the
   * top of the viewport (tab strip), where a "below" tooltip would
   * overlap the tab content under the strip. Both placements
   * automatically flip if their preferred axis would clip the
   * viewport — `preference` just decides which side we try first.
   */
  placement?: "below" | "above";
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const GAP = 6;
    const SAFE = 8;

    // Horizontal: align tooltip's left edge with the anchor's left,
    // right-flip when the default would clip, then clamp to viewport
    // left margin so it never escapes past x<0.
    let left = anchor.left;
    if (left + rect.width > window.innerWidth - SAFE) {
      left = anchor.right - rect.width;
    }
    left = Math.max(SAFE, left);

    // Vertical: try the preferred side first, flip when it doesn't
    // fit. Floor at SAFE so we never paint above the viewport top.
    let top: number;
    if (placement === "above") {
      top = anchor.top - GAP - rect.height;
      if (top < SAFE) top = anchor.bottom + GAP;
    } else {
      top = anchor.bottom + GAP;
      if (top + rect.height > window.innerHeight - SAFE) {
        top = anchor.top - GAP - rect.height;
      }
    }
    top = Math.max(SAFE, top);

    setPos({ top, left });
  }, [anchor, placement]);

  return createPortal(
    <motion.div
      ref={tooltipRef}
      initial={{ opacity: 0, y: placement === "above" ? 4 : -4 }}
      animate={
        pos
          ? { opacity: 1, y: 0 }
          : { opacity: 0, y: placement === "above" ? 4 : -4 }
      }
      exit={{
        opacity: 0,
        y: placement === "above" ? 3 : -3,
        transition: { duration: 0.12 },
      }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      style={{
        position: "fixed",
        // First render: park far off-screen so the unmeasured tooltip
        // never paints in the wrong place. After useLayoutEffect runs
        // we re-render with measured coordinates before the browser
        // commits the frame.
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        maxWidth,
        backgroundColor: "var(--surface-4)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-sm)",
        padding: "6px 10px",
        fontSize: "var(--text-xs)",
        fontFamily: "var(--font-sans)",
        fontWeight: "var(--weight-medium)",
        letterSpacing: "var(--tracking-tight)",
        lineHeight: 1.4,
        // Tab-summary tooltips wrap; icon-button tooltips are short
        // single-line labels and won't break visually.
        whiteSpace: "normal",
        pointerEvents: "none",
        boxShadow: "0 2px 8px oklch(0% 0 0 / 0.35)",
        zIndex: 1100,
      }}
    >
      {label}
    </motion.div>,
    document.body,
  );
}

/**
 * Convenience re-export for callers that import the open-state
 * wrapper alongside the visual.
 */
export { AnimatePresence };
