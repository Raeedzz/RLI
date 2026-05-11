/**
 * Minimal "agent running" loader. A single thin arc rotating at a
 * steady angular velocity — that's it. No glow, no pulse, no double
 * ring, no easing-induced jitter. Calm enough to leave on indefinitely
 * but unmistakable as "in progress."
 *
 * Visual contract:
 *   - 14px square (sized via the `size` prop, defaults to 14)
 *   - 1.5px stroke in `currentColor` so it inherits whatever accent
 *     the parent sets (sidebar uses `--accent`, tab strip uses
 *     `--accent`, hover cards use `--accent`)
 *   - 270° arc with rounded caps; 90° gap so the rotation is visible
 *   - 1.2s per revolution, linear easing (any other curve produces
 *     uneven angular velocity that draws the eye)
 *
 * Hardening:
 *   - SVG only, no JS animation loop — CSS keyframes drive the
 *     rotation, which the compositor handles entirely off the main
 *     thread. No frame-budget cost from running this even on dozens
 *     of tabs in parallel.
 *   - `aria-hidden` so it doesn't pollute screen-reader output. The
 *     visible "running" state is conveyed by surrounding chrome (tab
 *     badge, hover-card spinner) which carry their own labels.
 *   - prefers-reduced-motion: the global rule in tokens.css collapses
 *     animation-duration to ~0ms, which freezes the arc at its initial
 *     angle. Still readable as a partial-circle indicator; no flicker
 *     or staccato motion. We don't try to swap to a static dot because
 *     the reduced-motion gate is environmental — at the moment the
 *     setting flips on, swapping geometry would itself be a visible
 *     transition we don't want.
 *   - `will-change: transform` keeps the element on its own
 *     compositor layer; without it, the rotation can re-rasterize
 *     each frame on slower GPUs and look choppy.
 *   - `transform-origin: 50% 50%` is explicit even though it's the
 *     default — guards against future stylesheet changes that might
 *     globally override the origin.
 *   - Single element rotation: rotating the wrapper span (not the
 *     SVG itself) avoids cross-browser quirks with `transform-box`
 *     on SVG children, which Safari historically gets wrong.
 *
 * Reused across the sidebar worktree rows, the main-column tab
 * strip, the right-panel secondary terminal indicator, and the
 * worktree hover-card status dot. One implementation = one motion
 * grammar across the app.
 */
export function Loader({
  size = 14,
  strokeWidth = 1.5,
}: {
  /** Pixel size of the square. Default 14. */
  size?: number;
  /** Arc stroke width. Bump up for larger sizes if you want it to read. */
  strokeWidth?: number;
}) {
  // Geometry: viewBox 0..14, center 7,7, radius 5.5 (leaves 1.5px room
  // for the stroke). Circumference is ~34.56. Pick a dasharray that
  // paints ~75% of the circle.
  const RADIUS = 5.5;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ≈ 34.56
  const ARC = CIRCUMFERENCE * 0.72; // ~259° arc — quietly less than 3/4
  const GAP = CIRCUMFERENCE - ARC;
  return (
    <span
      className="rli-loader"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        flexShrink: 0,
        // currentColor lets each caller drive accent/state colors
        // without prop drilling.
        color: "currentColor",
        // Keep the spinner on its own compositor layer; rotation stays
        // smooth even when many are visible simultaneously.
        willChange: "transform",
        transformOrigin: "50% 50%",
      }}
      aria-hidden
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 14 14"
        // `display: block` removes the inline-baseline whitespace below
        // SVGs that would otherwise nudge the icon down by 2-3px and
        // make the rotation look off-center against neighboring text.
        style={{ display: "block" }}
      >
        <circle
          cx={7}
          cy={7}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${ARC} ${GAP}`}
        />
      </svg>
    </span>
  );
}
