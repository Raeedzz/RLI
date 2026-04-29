import { useEffect } from "react";

type Direction = "up" | "down" | "left" | "right";

const ARROW_TO_DIRECTION: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]';

/**
 * Global spatial focus navigation. Once Tab has put focus on any
 * element, the arrow keys move focus to the nearest visible focusable
 * element in that direction — like a TV remote on the UI grid.
 *
 * Widget-level handlers (the activity rail's vertical roving focus, the
 * session tablist's horizontal one) run FIRST and call stopPropagation,
 * so when the user hits ↓ inside the rail, the rail handles it and we
 * never see the event. The arrows only fall through to this hook when
 * the focused widget didn't claim them — at which point we hop into
 * the next widget over.
 *
 * Bail when focus is in a text input / textarea / contenteditable so
 * the cursor's left/right arrow behavior keeps working.
 */
export function useSpatialNavigation() {
  useEffect(() => {
    // Track whether Tab is currently held down. The OS auto-repeat
    // fires keydown over and over while the key is held without an
    // intervening keyup, so any keydown that arrives while the flag
    // is set is a repeat — regardless of whether `e.repeat` is set
    // (which not every webview reports reliably).
    let tabHeld = false;

    // Capture-phase Tab handler. Runs BEFORE any element-level
    // keydown handler so it can suppress the prompt input's
    // completion-on-Tab and the browser's default focus walk on
    // every repeat. The first Tab press falls through normally.
    const onTabKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (tabHeld || e.repeat) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      tabHeld = true;
    };

    // Bubble-phase arrow handler. Widget-level handlers (rail,
    // tablist) run first and call stopPropagation, so we only fire
    // when nothing closer to the focus claimed the arrow.
    const onArrowKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const direction = ARROW_TO_DIRECTION[e.key];
      if (!direction) return;

      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return;

      // Don't steal arrows from text editing surfaces.
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active.isContentEditable
      ) {
        return;
      }

      const target = findNeighbor(active, direction);
      if (!target) return;

      e.preventDefault();
      target.focus();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Tab") tabHeld = false;
    };

    window.addEventListener("keydown", onTabKey, true);
    window.addEventListener("keydown", onArrowKey, false);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onTabKey, true);
      window.removeEventListener("keydown", onArrowKey, false);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);
}

/**
 * Pick the nearest visible focusable element whose center lies in the
 * given direction from `from`. We score by primary-axis distance plus
 * a 2× penalty on perpendicular distance so an aligned neighbor wins
 * over a diagonal one even if the diagonal one is closer in raw pixels.
 */
function findNeighbor(
  from: HTMLElement,
  direction: Direction,
): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => {
    if (el === from) return false;
    if (el.offsetParent === null) return false;
    // Skip react-resizable-panels drag handles — landing focus on one
    // would let its own arrow handler resize the panes, which the user
    // explicitly does not want from the navigation arrows.
    if (el.hasAttribute("data-resize-handle")) return false;
    return true;
  });
  if (candidates.length === 0) return null;

  const fromRect = from.getBoundingClientRect();
  const fromCx = fromRect.left + fromRect.width / 2;
  const fromCy = fromRect.top + fromRect.height / 2;

  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - fromCx;
    const dy = cy - fromCy;

    // 4px tolerance so near-aligned items don't get filtered out by
    // sub-pixel rounding (e.g. an element exactly horizontal to `from`
    // could have dy = -0.5 and miss the up/down filter otherwise).
    if (direction === "right" && dx <= 1) continue;
    if (direction === "left" && dx >= -1) continue;
    if (direction === "down" && dy <= 1) continue;
    if (direction === "up" && dy >= -1) continue;

    const horizontal = direction === "left" || direction === "right";
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
    const perp = horizontal ? Math.abs(dy) : Math.abs(dx);
    const score = primary + perp * 2;

    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}
