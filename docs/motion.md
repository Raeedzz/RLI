# RLI Motion Language

Motion as punctuation, not decoration. The interface is a confident dark instrument — every animation should feel like a finely-machined click, not a flourish. Linear's restraint, Warp's surface quality, Superhuman's keyboard-density tension.

> **Hard rule:** motion lives on chrome only. xterm.js terminal content, CodeMirror 6 editor content, file tree row updates, GStack screenshot stream, palette result list filtering — all instant, never animated.

---

## Hero moment — the session tab strip

The single signature animation in RLI. Two synchronized motions:

### 1. The active-tab indicator (shared layoutId)

A 2px top border lives at the top of the active session tab. When the user switches tabs (click, ⌘1..9, ⌘\[/]), the indicator does **not** fade — it **slides** along the tab strip via Motion's `layoutId="rli-active-tab"`, animating from one tab's top edge to another.

- **Spring** (the one place RLI uses a true physical spring):
  ```
  type: spring
  stiffness: 380
  damping: 32
  mass: 0.8
  ```
  At these values the indicator settles in ~180ms with no visible overshoot but feels alive — not the stiff CSS transition of a generic IDE, not the bouncy spring of a consumer app.
- The indicator color is `var(--accent)` (steel blue), 2px tall, runs the full width of the active tab.
- The tab background swap (active = `surface-2`, inactive = `surface-1`) is **instant** — the slide is the visual anchor. Animating both fights itself.

### 2. The streaming-agent status dot

A 6px dot before the tab title. When the agent in that session is actively producing output (PTY bytes received in the last ~600ms), the dot uses `--accent` and pulses:

```css
@keyframes rli-pulse {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1; }
}
.streaming-dot { animation: rli-pulse 1.4s var(--ease-in-out) infinite; }
```

Opacity-only — never scale. Scale on a status dot reads as urgency or alarm. We just want a quiet heartbeat.

When the agent goes idle (3s silence + prompt regex match), the pulse stops, dot color shifts to `--text-tertiary` over 200ms (CSS color transition).

When tab summary updates after idle: the new subtitle text crossfades old → new in 200ms quart-out (opacity only, no slide). Only animation that touches *content* in this UI — justified because the subtitle changing is a meaningful event.

---

## The five-line motion budget

Per CONTEXT.md, RLI optimizes for time-to-first-byte on every interaction. So the budget is brutally short:

1. **Default duration** for any chrome state change: **150ms**.
2. **Default easing**: `--ease-out-quart`.
3. **Animate `transform` and `opacity` only.** Never width/height/top/left/padding/margin. For collapses use `grid-template-rows: 0fr ↔ 1fr`.
4. **Exit duration** = 75% of entrance.
5. **Stagger cap**: 8 items × 30ms. Beyond that, reveal en masse.

Anything that violates these is a deliberate exception, documented below.

---

## Per-surface specifications

### Project rail (48px, left)

| Action | Spec |
|---|---|
| Project icon hover | `background-color` `surface-2`, transition 100ms quart-out |
| Project icon active state | Left-edge 2px `--accent` strip via shared `layoutId="rli-active-project"`. Same spring as tab indicator. The strip slides between projects on switch. |
| Drag to reorder | dnd-kit handles drag. Ghost item: `scale(1.03) + boxShadow(--shadow-popover)`, transition 120ms quart-out. Drop zone indicator: a 2px accent line between target items, instant fade-in 80ms |
| New project icon entrance | `opacity: 0 → 1`, no transform, 200ms quart-out, only the *new* icon (not the entire rail re-staggering) |

### Session tab strip (top)

| Action | Spec |
|---|---|
| Active tab indicator | Spring (380/32/0.8), `layoutId="rli-active-tab"`, top 2px |
| Active tab background | Instant swap — no transition |
| Inactive tab hover | `background-color` to `surface-2`, 100ms quart-out |
| Tab close button hover | `background-color` to `surface-3`, 80ms |
| Streaming dot pulse | CSS keyframe `rli-pulse` 1.4s ease-in-out infinite, opacity 0.55↔1 |
| Idle dot color shift | 200ms color transition |
| Subtitle text update | Crossfade old→new, opacity-only, 200ms quart-out (single legit content animation) |
| Tab drag-reorder | Motion `<Reorder.Group/Item>`, layoutId-based, 200ms — DO NOT use `transition: spring`; the linear timing prevents overshoot of long tabs |
| New tab spawn | Width animates from 0 to natural via `grid-template-columns 0fr → 1fr`, opacity 0 → 1, both 220ms quart-out, simultaneous |
| Tab close (dismiss) | Width to 0fr + opacity to 0, 160ms ease-in-quart |

### Resizable split dividers

| Action | Spec |
|---|---|
| Divider hover | Width 1px → 3px in 100ms quart-out. Color `--border-hairline` → `--accent-muted` over the same duration |
| Active drag | **Instant** width swap to 3px, color to `--accent`. Tracks mouse 1:1, no easing |
| Pane resize during drag | No transition on the panes themselves — they follow the divider position frame-perfectly |

### Pane headers (28px chrome strips)

| Action | Spec |
|---|---|
| Action button hover | `background-color` to `surface-2`, 100ms quart-out |
| Action button press | `transform: scale(0.96)` on `:active`, 60ms ease-in-quart, restored 100ms ease-out-quart |
| Pane focus | 1px inner ring of `--accent-muted` appears via `box-shadow inset`, 120ms quart-out (only when keyboard-focused via Tab; mouse focus is implicit) |

### Command palette (⌘K)

| Action | Spec |
|---|---|
| Backdrop fade-in | `opacity: 0 → 1` in 120ms quart-out |
| Container mount | `opacity: 0 → 1` + `translateY(-6px → 0)` + `scale(0.985 → 1)`, 200ms quart-out, all GPU-cheap |
| Backdrop dismiss | `opacity: 0` in 100ms ease-in-quart |
| Container dismiss | `opacity: 0` + `translateY(-4px)` + `scale(0.99)`, 150ms ease-in-quart |
| Result row hover | `background-color` 100ms |
| Result row keyboard cursor | **Instant** background swap — keyboard navigation must never feel laggy. The cursor is the *user*; latency reads as broken |
| Result list filter | **Instant** — no list-shift animation, no fade. Items appear/disappear immediately as the user types |

### Connections view (⌘⇧;)

| Action | Spec |
|---|---|
| Mount (slides into right column) | `translateX(24px → 0)` + `opacity: 0 → 1`, 240ms quart-out |
| Dismiss | `translateX(16px)` + `opacity: 0`, 180ms ease-in-quart |
| Filter chip toggle | `background-color` 120ms |
| Row hover | `background-color` 100ms |
| Row expand (click to reveal description + tools) | `grid-template-rows: 0fr → 1fr` in 220ms quart-out + `opacity` on the inner detail content from 0 → 1 starting at 60ms in. Chevron icon rotates from 0° → 90° over the same 220ms |
| Row collapse | Reverse, 165ms ease-in-quart |

### Margin annotation card (highlight-and-ask answer)

| Action | Spec |
|---|---|
| Mount | `translateX(16px → 0)` + `opacity: 0 → 1`, 200ms quart-out |
| Dismiss (Esc or click-outside) | `translateX(8px)` + `opacity: 0`, 140ms ease-in-quart |
| Loading state (waiting for Gemini) | Three 4px dots, JetBrains Mono `.`, staggered opacity loops 200ms apart, 1.2s cycle, ease-in-out |
| Streaming response | Text appears character-by-character at the rate Gemini streams it. **Not** a typewriter effect — just rendering as bytes arrive, no per-character animation |

### Modals (session close, etc. — rare)

| Action | Spec |
|---|---|
| Backdrop | `opacity: 0 → 1` in 140ms quart-out |
| Container | `opacity: 0 → 1` + `scale(0.96 → 1)`, 220ms quart-out |
| Dismiss | `opacity: 0` + `scale(0.98)`, 160ms ease-in-quart, backdrop 100ms ease-in-quart |
| Button focus inside modal | Standard focus-visible ring, no special motion |

### Toasts (rare — inline status preferred)

| Action | Spec |
|---|---|
| Mount | `translateX(20px → 0)` + `opacity: 0 → 1`, 220ms quart-out, slides in from right edge |
| Dismiss (manual or auto-timeout) | `translateX(20px)` + `opacity: 0`, 180ms ease-in-quart |
| Stack rearrange when one dismisses | Layout via Motion `layoutId`, 200ms quart-out (springless — clean linear settle) |

### Buttons

| Action | Spec |
|---|---|
| Hover | `background-color` 100ms quart-out |
| Press | `transform: scale(0.97)` 80ms ease-in-quart, return 120ms ease-out-quart |
| Focus-visible | Outline appears instantly (CSS) — focus rings should never lag keyboard navigation |
| Loading | `<Pulse>` wrapper showing three dots animation; primary button bg dims to `--accent-press` |

### Form inputs (text fields, textareas)

| Action | Spec |
|---|---|
| Focus | `border-color` to `--border-strong`, 120ms quart-out |
| Error state | `border-color` to `--state-error`, 140ms quart-out, **no shake** (shakes are tacky) |

### Drop zones (drag-and-drop targets)

| Action | Spec |
|---|---|
| Drag enter | Background tint `--accent-muted` overlay at 0.15 opacity, 120ms quart-out |
| Drag leave | Reverse, 100ms ease-in-quart |
| Drop accepted | Background flash `--state-success-bg` for 200ms then fade to default in 200ms |

---

## What we deliberately do NOT animate

If you're tempted to animate any of these, the answer is no:

- xterm.js terminal contents (cursor blink also off — see `xterm-theme.ts`)
- CodeMirror 6 editor contents (no fade-in on file open, no smooth scroll)
- File tree row updates from the file watcher (immediate visual update on disk change)
- GStack screenshot stream (instant frame swap)
- Search results in palette (instant filter, no list reorder transition)
- Tab content area on tab switch (instant; the indicator does the work)
- Project switch (the rail strip slides; everything else swaps instantly)
- Status badge color changes outside the streaming dot
- Loading spinners on data fetches > 200ms (use skeleton patches instead)
- Notification indicators (instant on/off — pulsing notifications are the most common AI-slop fingerprint)

---

## Reduced motion fallback

`prefers-reduced-motion: reduce` triggers an aggressive override:

- **All transforms removed.** Only opacity changes survive.
- **Tab indicator** stops being a spring — instant move (still `layoutId`-based for accessibility, just no animation).
- **Status dot pulse** becomes static at opacity 1 (no animation).
- **All durations clamped to 80ms.**
- **Linear easing** for everything that remains (no curves).

Functional motion is preserved: focus rings, loading state indicators (slowed), button feedback (instant). Spatial motion is dropped.

The override is implemented globally in `tokens.css`'s `@media (prefers-reduced-motion: reduce)` block, plus per-component variant overrides in `motion.ts` that detect the preference via Motion's `useReducedMotion()` hook and swap to opacity-only variants.

---

## What "confident dark instrument" rejects

Concrete examples to make the negative space sharp:

- ❌ Fade-up-on-scroll content reveals (we don't have marketing pages)
- ❌ Hover lift with shadow growth (we use surface lightening, not shadows for depth)
- ❌ Bounce/elastic anything (`cubic-bezier(0.34, 1.56, 0.64, 1)` is banned)
- ❌ Springs on every motion (only the tab indicator and project strip are springs — everything else is a deterministic curve)
- ❌ Animated gradients
- ❌ Glow/pulse on focus rings (instant, sharp ring; no breathing)
- ❌ Slide-in feedback on form errors (just the border color shift)
- ❌ Skeleton shimmer (skeletons are static blocks; "shimmer" is decoration)
- ❌ Hover-card flips, parallax tilts, magnetic buttons
- ❌ Page-load orchestration with staggered hero reveals (RLI doesn't have a "page load" — it has an instant cold start)
- ❌ Number flip animations on counters
- ❌ Confetti or particle effects, ever

---

## Implementation files

- `motion.ts` — Motion library variants, transitions, layoutId constants, hooks
- `motion.css` — CSS-only animations (status dot pulse, loading dots) that don't need React state
- `tokens.css` — already has duration + easing tokens

The React app imports variants from `motion.ts` and applies them as `<motion.div variants={...} initial="hidden" animate="visible" exit="exit" />`. CSS keyframes from `motion.css` are applied as plain class names.
