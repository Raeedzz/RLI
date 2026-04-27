import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { dropdownVariants } from "@/design/motion";
import { TAG_IDS, type TagId } from "@/state/types";

interface Props {
  /** Viewport coordinates of the right-click that opened the picker. */
  anchor: { x: number; y: number };
  selected: TagId;
  onSelect: (id: TagId) => void;
  onClose: () => void;
}

// Width math: 8 swatches × 22px + 7 gaps × 4px + 2 × 8px padding = 222px
const W = 222;
const H = 44;
const SWATCH = 22;
const GAP = 4;
const PAD = 8;

/**
 * Tiny popover with one row of 8 tag-color swatches. Mounted at the
 * right-click position; auto-flips to stay inside the viewport.
 *
 * Esc / click-outside / swatch-click all dismiss.
 *
 * Selected swatch is marked with a 2px dark inner ring (contrasts on
 * every color, never glow). Hover scale 1.08 — micro-interaction only,
 * no AI shimmer.
 */
export function ColorPicker({ anchor, selected, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Defer mousedown to next tick so the right-click that opened us
    // doesn't immediately close us.
    const timer = window.setTimeout(
      () => window.addEventListener("mousedown", onClickOutside),
      0,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onClickOutside);
    };
  }, [onClose]);

  // Edge-flip — keep popover within the viewport with 8px padding
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - H - 8));

  return (
    <motion.div
      ref={ref}
      role="listbox"
      aria-label="Tab color"
      variants={dropdownVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{
        position: "fixed",
        left,
        top,
        width: W,
        height: H,
        padding: PAD,
        boxSizing: "border-box",
        backgroundColor: "var(--surface-3)",
        border: "var(--border-2)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-popover)",
        zIndex: "var(--z-dropdown)",
        display: "flex",
        gap: GAP,
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      {TAG_IDS.map((id) => (
        <Swatch
          key={id}
          id={id}
          active={id === selected}
          onClick={() => {
            onSelect(id);
            onClose();
          }}
        />
      ))}
    </motion.div>
  );
}

function Swatch({
  id,
  active,
  onClick,
}: {
  id: TagId;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      aria-label={`set color to ${id}`}
      title={id}
      onClick={onClick}
      style={{
        width: SWATCH,
        height: SWATCH,
        flexShrink: 0,
        borderRadius: "var(--radius-pill)",
        border: "none",
        padding: 0,
        backgroundColor: `var(--tag-${id})`,
        boxShadow: active
          ? "inset 0 0 0 2px oklch(0% 0 0 / 0.45)"
          : "none",
        cursor: "default",
        transition: "transform 80ms var(--ease-out-quart)",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.transform = "scale(1.08)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.transform = "scale(1)")
      }
    />
  );
}
