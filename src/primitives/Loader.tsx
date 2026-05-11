/**
 * "Agent running" pulse — a single filled circle that scales 0→1 while
 * fading 1→0, then loops. Replaces the previous rotating arc with a
 * gentler in-and-out breath. The shape of the keyframe IS the entrance
 * and exit; no extra animation choreography needed.
 *
 * Visual contract:
 *   - Square slot sized via the `size` prop (defaults to 14).
 *   - A single circle that fills the slot at peak scale.
 *   - `currentColor` for the fill so callers inherit accent/state
 *     colors (sidebar uses `--accent`, hover cards use `--accent`).
 *
 * Hardening:
 *   - Animation lives in `src/design/tokens.css` (`@keyframes
 *     rli-loader-pulse`). Single source of truth means the cadence
 *     can be retuned project-wide from one place.
 *   - 1.6s ease-in-out cycle. Long enough to read as calm, short
 *     enough to feel alive. Symmetrical curve means the bloom and
 *     the fade share the same easing shape.
 *   - transform + opacity only — the compositor handles the whole
 *     animation off the main thread.
 *   - `will-change: transform, opacity` keeps the element on its own
 *     compositor layer; without it slower GPUs can re-rasterize per
 *     frame and look choppy.
 *   - `transform-origin: 50% 50%` is explicit so future stylesheet
 *     changes can't shift the bloom off-center.
 *   - prefers-reduced-motion: the global rule in tokens.css collapses
 *     animation-duration to ~0ms. The dot rests at its starting state
 *     (scale 0) and renders as nothing. Callers that need a visible
 *     reduced-motion analogue paint their own static dot in the same
 *     slot — see `HoverCardStatusDot` in Sidebar.tsx.
 *   - `aria-hidden` so screen readers don't announce decorative motion.
 *     The visible "running" state is conveyed by surrounding chrome
 *     (tab badge, hover card) which carry their own labels.
 *
 * Reused across the sidebar worktree rows, the main-column tab strip,
 * the right-panel secondary terminal indicator, and the worktree
 * hover-card status dot. One implementation = one motion grammar.
 */
export function Loader({
  size = 14,
}: {
  /** Pixel size of the square slot. Default 14. */
  size?: number;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        flexShrink: 0,
        color: "currentColor",
      }}
      aria-hidden
    >
      <span
        className="rli-loader"
        style={{
          display: "block",
          width: size,
          height: size,
          borderRadius: "50%",
          backgroundColor: "currentColor",
          willChange: "transform, opacity",
          transformOrigin: "50% 50%",
        }}
      />
    </span>
  );
}
