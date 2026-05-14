import type { CSSProperties } from "react";

/**
 * "Agent running" snake-wave — a 3×3 grid of small squares with a
 * muted-white crest that walks a clockwise spiral inward, looping
 * indefinitely. Replaces the previous scaleout pulse with a steadier,
 * more textural indicator: the wave is always visible, never zeroed
 * out, so the eye never wonders whether the loader is still on.
 *
 * Visual contract:
 *   - Square slot sized via the `size` prop (defaults to 14). The
 *     grid takes `floor(size / 3) * 3`, so 18 ⇒ 18px, 16 ⇒ 15px, etc.
 *   - 9 cells in a row-major 3×3 grid, snake-ordered for the wave:
 *
 *         0 1 2          0 → 1 → 2
 *         3 4 5    →             ↓
 *         6 7 8          3 ← 4   5
 *                        ↑     ↓
 *                        6 ← 7   8 (inward spiral ending at center)
 *
 *   - 5-stop muted palette in OKLCH, mirrored to 9 positions so the
 *     crest reads as a smooth rise-and-fall instead of a hard wrap.
 *
 * Motion:
 *   - Pure CSS keyframes. Each cell carries `--gli-loader-snake-pos`
 *     (its 0..8 position along the spiral); the `.gli-loader-cell`
 *     class runs a 1.35s keyframe walk through the palette with a
 *     negative `animation-delay` derived from that position, so each
 *     cell sits at its own phase and the wave reads as a single crest
 *     drifting across the grid.
 *   - The animation runs on the compositor thread, NOT the React
 *     main thread. Under load (20+ agents streaming, tab-switch
 *     storms, big diffs in flight) the loader stays visually
 *     continuous — the previous React-state implementation could
 *     stall for a frame whenever the commit queue backed up, which
 *     read as "the spinner just stopped" to the user.
 *
 * Hardening:
 *   - No setInterval, no React state, no document.querySelector. Each
 *     instance is just nine spans with a class and a CSS variable.
 *   - prefers-reduced-motion freezes every cell at a calm mid-palette
 *     stop — the indicator still reads as "active", just motionless.
 *   - aria-hidden — decorative; the "running" state is conveyed by
 *     surrounding chrome (tab badge, hover card) with proper labels.
 *
 * Used in: sidebar worktree row, main-column tab strip, right-panel
 * secondary terminal indicator, worktree hover-card status, updater
 * toast. One implementation, one motion grammar.
 */

// Snake order: each entry is a 0..8 grid index, ordered along the
// inward clockwise spiral. SNAKE_POS_BY_GRID[i] = "where in the snake
// path does grid cell i sit?" — flipped form, pre-computed so we
// don't search per cell on every render.
const SNAKE_ORDER = [0, 1, 2, 5, 8, 7, 6, 3, 4];
const SNAKE_POS_BY_GRID = SNAKE_ORDER.reduce<number[]>(
  (acc, gridIdx, snakePos) => {
    acc[gridIdx] = snakePos;
    return acc;
  },
  new Array(9),
);

export function Loader({
  size = 14,
}: {
  /** Pixel size of the square slot. Default 14. */
  size?: number;
}) {
  // Squares are integer-sized so they line up pixel-perfect on the
  // grid (CSS subpixel rounding can leave hairline seams between cells
  // otherwise). Minimum 2px so the wave is still visible at small sizes.
  const squareWidth = Math.max(2, Math.floor(size / 3));
  const gridWidth = squareWidth * 3;

  return (
    <span
      style={{
        display: "inline-grid",
        gridTemplateColumns: `repeat(3, ${squareWidth}px)`,
        gridTemplateRows: `repeat(3, ${squareWidth}px)`,
        width: gridWidth,
        height: gridWidth,
        flexShrink: 0,
      }}
      aria-hidden
    >
      {Array.from({ length: 9 }).map((_, gridIndex) => {
        const snakePos = SNAKE_POS_BY_GRID[gridIndex];
        return (
          <span
            key={gridIndex}
            className="gli-loader-cell"
            style={
              {
                "--gli-loader-snake-pos": snakePos,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}
