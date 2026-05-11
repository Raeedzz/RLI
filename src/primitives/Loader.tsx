import { useEffect, useState } from "react";

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
 *   - One palette rotation per 150ms. Full cycle = 9 × 150ms = 1.35s.
 *   - `transition: background-color 150ms linear` on each cell so the
 *     color step doesn't snap — the whole grid drifts as one.
 *
 * Hardening:
 *   - React state drives the rotation, not raw DOM mutation. No
 *     references to globals, no `document.querySelector`, safe to
 *     mount many instances in parallel (each owns its own interval).
 *   - prefers-reduced-motion: the effect bails out and the grid
 *     freezes at step 0. The static snapshot still reads as the
 *     indicator's signature, just without motion.
 *   - aria-hidden — decorative; the "running" state is conveyed by
 *     surrounding chrome (tab badge, hover card) with proper labels.
 *
 * Used in: sidebar worktree row, main-column tab strip, right-panel
 * secondary terminal indicator, worktree hover-card status, updater
 * toast. One implementation, one motion grammar.
 */

// Five steps of muted near-whites — very low chroma, ascending
// lightness. The hue tracks the project's cool-tinted neutrals
// (`hue 250`) so the crest matches the surface palette instead of
// reading as a foreign color.
const PALETTE_BASE = [
  "oklch(36% 0.003 250)",
  "oklch(54% 0.003 250)",
  "oklch(72% 0.003 250)",
  "oklch(86% 0.003 250)",
  "oklch(96% 0.003 250)",
];

// 9-position palette: 0..4..0 mirrored. The crest rises then falls
// instead of teleporting back to the dimmest stop.
const PALETTE = [
  PALETTE_BASE[0],
  PALETTE_BASE[1],
  PALETTE_BASE[2],
  PALETTE_BASE[3],
  PALETTE_BASE[4],
  PALETTE_BASE[3],
  PALETTE_BASE[2],
  PALETTE_BASE[1],
  PALETTE_BASE[0],
];

// Snake order: each entry is a 0..8 grid index, ordered along the
// inward clockwise spiral. SNAKE_POS_BY_GRID[i] = "where in the snake
// path does grid cell i sit?" — flipped form, pre-computed so we
// don't search per cell on every render.
const SNAKE_ORDER = [0, 1, 2, 5, 8, 7, 6, 3, 4];
const SNAKE_POS_BY_GRID = SNAKE_ORDER.reduce<number[]>((acc, gridIdx, snakePos) => {
  acc[gridIdx] = snakePos;
  return acc;
}, new Array(9));

const TICK_MS = 150;

export function Loader({
  size = 14,
}: {
  /** Pixel size of the square slot. Default 14. */
  size?: number;
}) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const id = window.setInterval(() => {
      setStep((s) => (s + 1) % PALETTE.length);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

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
        const color = PALETTE[(snakePos + step) % PALETTE.length];
        return (
          <span
            key={gridIndex}
            style={{
              backgroundColor: color,
              transition: `background-color ${TICK_MS}ms linear`,
              willChange: "background-color",
            }}
          />
        );
      })}
    </span>
  );
}
