import { useCallback, type KeyboardEvent } from "react";

type Orientation = "vertical" | "horizontal";

/**
 * Roving-focus arrow-key navigation for a container of focusable children.
 *
 * Drop the returned `onKeyDown` on a wrapper element; whenever focus is
 * inside it, ↑/↓ (vertical) or ←/→ (horizontal) hop to the previous/next
 * focusable descendant. Home/End jump to first and last. The CSS
 * `:focus-visible` rule paints the blue border so the user can see
 * where focus is.
 *
 * At the boundaries (first item + prev, last item + next) we DON'T
 * wrap — we let the event bubble untouched. The global
 * `useSpatialNavigation` hook then takes over and hops focus to the
 * nearest focusable in that direction OUTSIDE the widget — e.g.
 * pressing ← on the leftmost session tab walks into the file tree or
 * activity rail rather than wrapping to the rightmost tab.
 *
 * Why a tiny custom hook instead of <RovingFocusGroup> from a library:
 * we already build everything from scratch, the focusables here are
 * native <button>s (no tabindex juggling needed since they're already
 * tab-focusable), and the behavior is one keydown switch.
 */
export function useArrowFocus(orientation: Orientation) {
  const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  const prev = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";

  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (
        e.key !== next &&
        e.key !== prev &&
        e.key !== "Home" &&
        e.key !== "End"
      ) {
        return;
      }
      const container = e.currentTarget;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [role="tab"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? focusables.indexOf(active) : -1;
      let target: HTMLElement | undefined;
      if (e.key === "Home") target = focusables[0];
      else if (e.key === "End") target = focusables[focusables.length - 1];
      else if (e.key === next) {
        // At the last item, don't wrap — let spatial nav take over so
        // the user can walk OUT of the widget into the next one over.
        if (idx === focusables.length - 1) return;
        target = focusables[idx + 1];
      } else {
        if (idx <= 0) return;
        target = focusables[idx - 1];
      }
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        target.focus();
      }
    },
    [next, prev],
  );
}
