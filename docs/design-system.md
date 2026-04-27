# RLI Design System

A confident dark instrument. Type-led. Mostly monochrome. Animation as punctuation, not decoration.

## Aesthetic direction

Three references collide here:
- **Cursor** for workspace structure
- **Warp** for terminal as a first-class native surface
- **Superhuman** for keyboard density, dark elegance, and the willingness to leave the screen *quiet*

If the AI Slop Test asks "could a generic AI have made this," the answer must be no. We avoid every fingerprint:

- ❌ Cyan-on-dark, purple-to-blue gradients, neon glow accents
- ❌ Glassmorphism, blur effects, glass cards
- ❌ Rounded rectangles with generic drop shadows
- ❌ Pure black backgrounds
- ❌ Gradient text on metrics
- ❌ Icons with rounded corners above every heading
- ❌ Card-everywhere layouts
- ❌ Inter / Roboto / Open Sans

What we *do*:
- ✅ Warm-tinted dark neutrals (hue 60, low chroma 0.005). Never pure gray, never pure black.
- ✅ One single accent color, **steel blue**, used only for primary actions and active focus. The rest of the chrome is monochrome.
- ✅ State changes communicated by **brightness shift**, not hue. Hover = lift one neutral step. Active = lift two. Focus = ring.
- ✅ Tight radii (2–8px). Desktop precision, not consumer-app pillows.
- ✅ Depth via surface lightening, **not shadows**. Shadows reserved for popovers/menus floating above content.
- ✅ Hairlines (1px borders, low chroma) over heavy strokes.
- ✅ **Geist Sans** for chrome, **JetBrains Mono** for terminal + editor + inline code.
- ✅ Tabular numerals everywhere counts/timers/sizes are shown.
- ✅ Motion: 100/300/500 rule, exponential easing (quart-out), no bounce, no elastic.

## The unforgettable thing

The session tab strip. Each tab shows a name and an 11px subtitle of what its agent is currently doing — updated when the agent goes idle. The strip should read like a control panel of running engines: each tab a piston, each status dot a tachometer. Tasteful, minimal, and slightly magical.

Every other design choice supports this surface being scannable in 200ms.

---

## Type system

### Families

```css
--font-sans:  "Geist", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
--font-mono:  "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
```

**Geist Sans** — Vercel's grotesque. Distinctive forms (the lowercase `g`, the tail on `y`), excellent rendering at small sizes, real tabular numerals. Free + OFL.

**JetBrains Mono** — gold standard developer mono. Wider than most monos, ligatures-off by default for code clarity. Terminals and editors live here.

Sans is for *chrome*. Mono is for *content surfaces*. Never the other way around — using mono for chrome is "lazy shorthand for technical vibes" (skill rule). Using sans inside terminals is wrong.

### Scale

5-step modular scale, fixed (not fluid — we're a desktop app, not a marketing site):

| Token | Size | Line | Use |
|---|---|---|---|
| `--text-2xs` | 10px | 14px | Status dots, badges, key chord captions |
| `--text-xs` | 11px | 16px | **Tab subtitles**, file metadata, tertiary info |
| `--text-sm` | 12px | 18px | Secondary UI, palette items, tooltips |
| `--text-base` | 13px | 20px | **Default body — tab titles, menu items, panel headings** |
| `--text-md` | 15px | 22px | Modal/dialog body |
| `--text-lg` | 18px | 26px | Section heading inside panels |
| `--text-xl` | 22px | 30px | Empty-state hero, onboarding |

13px (not 14, not 16) is the body baseline. This matches the density of Linear, Warp, and Superhuman, all of which run tight body type. Vertical rhythm uses the 4pt spacing scale, not the line-height as base — a deliberate trade for desktop density.

### Weights

- **400** Regular (default, tertiary text)
- **500** Medium (primary text, tab titles, button labels)
- **600** Semibold (headings, emphasis)
- **700** Bold (almost never — reserved for one-off display)

In dark mode, body text uses 450 (between Regular and Medium) when the font supports it, or 500 otherwise — light text on dark needs perceived weight reinforcement.

### OpenType

- Tabular numerals enabled globally (`font-variant-numeric: tabular-nums`). Tab subtitles, status counts, timers — all align.
- Ligatures enabled in chrome, disabled in terminal/editor.
- Kerning explicit (`font-kerning: normal`).

---

## Color

OKLCH only. HSL is dead. Pure gray is dead. Pure black is dead.

### Tinted neutrals (warm, hue 60)

Subtle warmth (chroma 0.005) makes the chrome feel like a workshop instrument, not a server room. The amount is barely perceptible in isolation but creates subconscious cohesion.

```css
--surface-0:  oklch(11% 0.005 60);   /* deepest — terminal/editor backgrounds */
--surface-1:  oklch(14% 0.005 60);   /* app background, panel backs */
--surface-2:  oklch(17% 0.005 60);   /* raised — tabs active, palette */
--surface-3:  oklch(21% 0.005 60);   /* highest — tooltips, dropdowns, menu hover */
--surface-4:  oklch(26% 0.005 60);   /* hover on surface-3 (rare) */

--border-hairline:  oklch(20% 0.005 60);  /* default 1px borders, dividers */
--border-default:   oklch(26% 0.005 60);  /* visible borders, input fields */
--border-strong:    oklch(34% 0.005 60);  /* hover/focus borders */

--text-primary:    oklch(95% 0.005 60);  /* body, tab titles */
--text-secondary:  oklch(74% 0.005 60);  /* subtitles, secondary labels */
--text-tertiary:   oklch(56% 0.005 60);  /* metadata, timestamps */
--text-disabled:   oklch(40% 0.005 60);  /* disabled state */
--text-inverse:    oklch(10% 0.005 60);  /* on accent fills */
```

### The single accent — steel blue

One color, used sparingly. Reserved for: primary action buttons (commit, push), active session indicator, keyboard focus ring, the 2px strip on the active project rail icon.

**Not cyan. Not violet. Not the AI accent palette.** Steel blue sits at hue 240 with restrained chroma (0.13), reads as "this thing is live / actionable" without a glow.

```css
--accent:        oklch(68% 0.13 240);
--accent-hover:  oklch(72% 0.13 240);
--accent-press:  oklch(62% 0.13 240);
--accent-muted:  oklch(40% 0.08 240);  /* for hairline accents on inactive surfaces */
--accent-focus:  oklch(72% 0.13 240 / 0.4);  /* the only legit alpha — focus ring */
```

### Diagnostic colors

Reserved for *state*: errors, warnings, success, in-progress. Low chroma so they don't scream against the warm-neutral chrome.

```css
--state-error:    oklch(64% 0.16 25);   /* red-orange, leans warm */
--state-warning:  oklch(78% 0.13 75);   /* amber */
--state-success:  oklch(70% 0.13 145);  /* sage green */
--state-info:     oklch(72% 0.10 220);  /* desaturated info blue, distinct from accent */

/* Subtle backgrounds for diagnostic surfaces (toast strips, badge fills) */
--state-error-bg:    oklch(22% 0.05 25);
--state-warning-bg:  oklch(22% 0.04 75);
--state-success-bg:  oklch(20% 0.04 145);
--state-info-bg:     oklch(20% 0.03 220);
```

### Diff colors (git panel)

Distinct from diagnostics. Lower chroma, read as code-tinted backgrounds.

```css
--diff-add-bg:     oklch(22% 0.04 145);
--diff-add-fg:     oklch(82% 0.10 145);
--diff-remove-bg:  oklch(22% 0.05 25);
--diff-remove-fg:  oklch(82% 0.12 25);
--diff-change-bg:  oklch(22% 0.04 75);
```

### Alpha discipline

Alpha is a design smell. We use it in exactly two places:
1. The focus ring (`--accent-focus`)
2. Modal backdrops (`oklch(0% 0 0 / 0.45)`)

Everywhere else, define an explicit overlay color from the surface scale.

---

## Spacing

4pt base. Semantic naming, not value-based.

```css
--space-px:   1px;
--space-0-5: 2px;
--space-1:   4px;
--space-1-5: 6px;
--space-2:   8px;
--space-3:   12px;
--space-4:   16px;
--space-5:   20px;
--space-6:   24px;
--space-8:   32px;
--space-10:  40px;
--space-12:  48px;
--space-16:  64px;
--space-20:  80px;
```

Use `gap` for sibling spacing. Use `padding` for container insets. Margins almost never.

**Density rules:**
- Inside a chrome row (tab, palette item, menu row): `padding: var(--space-2) var(--space-3)`.
- Between chrome groups (panel sections): `gap: var(--space-4)`.
- Page-level breathing room is rare in RLI. Most space is information.

---

## Radii

Tight. Desktop apps don't need consumer pillows.

```css
--radius-xs:    2px;  /* hairline tags, key chord glyphs */
--radius-sm:    4px;  /* default — buttons, inputs, tabs, menu rows */
--radius-md:    6px;  /* cards, popovers, the highlight-and-ask answer card */
--radius-lg:    8px;  /* command palette, modals, side panels */
--radius-pill:  9999px;
```

Most chrome is `radius-sm`. Anything bigger than `radius-lg` is wrong.

---

## Borders & shadows

### Borders

The 1px hairline is the workhorse. Borders separate, they don't decorate.

```css
--border-1:  1px solid var(--border-hairline);
--border-2:  1px solid var(--border-default);
--border-3:  1px solid var(--border-strong);
```

Inside a panel, prefer `border-bottom` between rows, not `border` boxing every row.

### Shadows

Mostly we don't use shadows — depth comes from the surface scale (lightening). The exception is *floating* surfaces (popovers, menus, dropdowns) that need to read as detached from the underlying chrome.

```css
--shadow-popover:  0 4px 16px oklch(0% 0 0 / 0.5),
                   0 0 0 1px var(--border-default);

--shadow-modal:    0 16px 48px oklch(0% 0 0 / 0.55),
                   0 0 0 1px var(--border-default);
```

The `0 0 0 1px` is the hairline, baked into the shadow so the popover sits cleanly on any surface.

---

## Motion

Animations live on chrome only. Terminal contents never animate. Editor contents never animate. The mouse pointer should never wait on motion before doing something.

### Tokens

```css
--motion-instant:  100ms;  /* button press, focus ring */
--motion-fast:     150ms;  /* tab/palette item hover, tooltip in */
--motion-base:     200ms;  /* state transitions */
--motion-slow:     280ms;  /* palette mount, modal entry */
--motion-slower:   400ms;  /* drawer/side-panel slide */

--ease-out-quart:  cubic-bezier(0.25, 1, 0.5, 1);     /* default for entrances */
--ease-out-quint:  cubic-bezier(0.22, 1, 0.36, 1);    /* punchier entrances */
--ease-in-quart:   cubic-bezier(0.5, 0, 0.75, 0);     /* exits */
--ease-in-out:     cubic-bezier(0.65, 0, 0.35, 1);    /* state toggles */
```

### Rules

- **Default ease:** `--ease-out-quart` for everything entering. Exit duration = 75% of entry.
- **Animate only `transform` and `opacity`.** Never width/height/padding/margin. For collapses use `grid-template-rows: 0fr → 1fr`.
- **Stagger cap:** 8 items max at 30ms each. Beyond that, no stagger.
- **`prefers-reduced-motion`:** all transforms become opacity-only crossfades, durations clamped to 80ms.
- **No bounce. No elastic.** Real instruments don't overshoot.

### Patterns

| Surface | Animation |
|---|---|
| Button hover | background-color 100ms |
| Tab activate | bottom border slides under via shared layout (Motion's `layoutId`) |
| Palette mount | opacity 0→1 + translateY(-6px)→0 in 180ms quart-out; backdrop 100ms fade |
| Modal mount | opacity + scale(0.97)→1 in 220ms quart-out |
| Tooltip | opacity 100ms fast-in, 75ms fast-out |
| Tab reorder (drag) | spring layout via Motion `layoutId` (one of the *only* spring-feeling motions, ~stiffness 320 damping 30) |
| Side panel slide-in | translateX(16px)→0 + opacity in 220ms quart-out |

---

## Per-surface specs

### Project rail (left, 48px)

- `width: 48px`, `background: var(--surface-1)`, `border-right: var(--border-1)`
- Project icons: 28px square, `radius-sm`, centered, vertical gap `--space-1`
- Hover: background `surface-2`, no transform
- Active: background `surface-3` + 2px steel-blue strip on the **left edge** (not a glow, not a ring — a literal strip flush to the screen edge)
- Drag-to-reorder: dnd-kit, ghost item lifts to `surface-3` with `shadow-popover`

### Session tabs (top, 32px)

This is the differentiation surface — give it the most care.

```
┌──────────────────────────────────┐
│ ● fix oauth redirect bug         │  ← 13px Geist Medium, --text-primary
│   Refactoring AuthProvider to…   │  ← 11px Geist Regular, --text-tertiary
└──────────────────────────────────┘
```

- Each tab: `min-width: 200px`, `max-width: 280px`, `height: 32px`
- Padding: `0 var(--space-3)`
- Two-line layout: tab title (13px medium) + subtitle (11px regular tertiary)
- Status dot: 6px, before title, with `var(--space-1-5)` gap.
  - **Active agent (streaming):** `--accent` with subtle pulse animation (1.4s, opacity 0.6→1, ease-in-out)
  - **Idle:** `--text-tertiary` (no pulse)
  - **Error:** `--state-error` (no pulse)
- Active tab: `background: var(--surface-2)`, no border-bottom (sits flush with the surface below it)
- Inactive tab: `background: var(--surface-1)`, hover lightens to `surface-2`
- Tab strip background: `surface-1`, `border-bottom: var(--border-1)`
- The active-tab indicator slides between tabs using Motion's `layoutId` — a single shared element, not per-tab transitions

### Recursive splits (resizable panels)

- Divider: 1px wide, `background: var(--border-hairline)`, `cursor: col-resize`/`row-resize`
- Hover on divider: 3px wide, `background: var(--accent-muted)`, transition 100ms
- Active drag: 3px wide, `background: var(--accent)`, no transition (follows mouse instantly)
- Each pane has a 28px header strip with `surface-1` bg and `border-bottom: var(--border-1)`

### Terminal pane chrome (xterm content untouched)

```
┌────────────────────────────────────────────────┐
│ ● agent · claude · 12 turns         …  ⊕  ✕  │  ← 28px header
├────────────────────────────────────────────────┤
│                                                │
│  $ claude                                      │  ← xterm, --surface-0 bg
│  > Refactor the auth middleware                │
│                                                │
└────────────────────────────────────────────────┘
```

- Pane header: 28px tall, `surface-1` background, `border-bottom: var(--border-1)`
- Header content: 12px Geist Medium, padding `0 var(--space-3)`
- Pane body (xterm): `surface-0` background, no padding (xterm controls its own internal padding)
- xterm theme uses our color tokens; cursor is steel-blue (`--accent`), block cursor, blink off

### Editor pane chrome (CodeMirror content untouched)

- Same chrome treatment as terminal
- File path + dirty indicator in header (12px Geist Mono for the path part — exception to the "no mono in chrome" rule because file paths read better in mono)
- Selection highlight uses `oklch(34% 0.06 240 / 0.4)` (steel-blue tinted)
- Highlight-and-ask answer card (margin annotation):
  - 320px wide, anchored to selected line range
  - `surface-2` background, `radius-md`, `border-1`
  - Padding `var(--space-3)`
  - Body: 12px Geist Regular, code in 11.5px JetBrains Mono
  - Slides in from right margin: `translateX(16px)→0` + opacity, 200ms quart-out
  - Dismissed on click-outside or Esc

### Command palette (⌘K)

- Centered overlay, `560px` wide, `max-height: 60vh`
- `surface-2` background, `radius-lg`, `shadow-modal`
- Backdrop: `oklch(0% 0 0 / 0.45)`, 100ms fade
- Search input: 44px tall, no border, `bg: transparent`, 15px Geist Regular
- Result rows: 36px, `padding: 0 var(--space-4)`
- Active row (keyboard cursor): `surface-3` background
- Right-aligned key chord glyphs in `text-tertiary`, monospace, in tiny 10px Geist Mono pills (`radius-xs`, `surface-3` bg)
- Mount: opacity + `translateY(-6px)→0` in 180ms quart-out

### Connections view (palette-summoned, ⌘⇧;)

Takes over the right column. Not a modal — a full panel.

- Top: filter bar (32px), `surface-1`, with chip toggles for `user` / `project` / `plugin`
- List: rows 48px tall, `border-bottom: var(--border-1)` between rows
- Each row layout: `[icon 16px] [name 13px medium] [type badge 10px] · · · [last-used 11px tertiary]`
- Type badge: `radius-xs`, padding `2px 6px`, `text-2xs`, semibold, tinted to type:
  - user: `--state-info-bg` bg, `--state-info` fg
  - project: `--state-success-bg` bg, `--state-success` fg
  - plugin: `--surface-3` bg, `--text-secondary` fg
- Click row → expands inline (grid-template-rows trick) to show description + tool list
- No hover lift. Hover = brightness shift of background only (`surface-1` → `surface-2`)

### Git panel

Three sections stacked: `Staged` / `Unstaged` / `Commit message`. Each section header is 24px tall, 11px semibold, all-caps, `text-tertiary`, with file count in tabular nums on the right.

- File row: 28px tall, with status letter (M/A/D/R/U) in `--text-tertiary` mono, file path, +N/-N additions in `--diff-add-fg`/`--diff-remove-fg`
- Diff viewer (when a file row is clicked): full pane below, monospace, line numbers in `--text-tertiary`
- "Generate commit message" button: pill-ish 28px, `radius-sm`, `--accent` background, white text, 12px medium. Loading state shows three pulsing dots in `--text-inverse`
- Commit textarea: 80px min-height, `surface-1` bg, `border-2`, JetBrains Mono 12px (commit messages are content, not chrome — mono is right here)
- `[Commit]` and `[Cancel]` buttons. `[Commit]` uses `--accent`, `[Cancel]` is ghost (transparent bg, `border-2`, `text-secondary`)

### GStack browser pane

Takes over the right column.

- Top: 28px URL display strip (`surface-1`, monospace 11px, `text-secondary`)
- Center: screenshot frame, fills the rest. `surface-0` background. Image swap is **instant** — no crossfade (would feel sluggish)
- Bottom: 200px tabbed log strip with `Console` / `Network` tabs
  - Each log line: 11px JetBrains Mono, `text-secondary`
  - Errors: `--state-error` left border (2px) + `--state-error-bg` row bg
  - Network rows: method · status · URL · time-ms (tabular nums)
- "Open in real browser" button at top-right of the screenshot frame: 24px ghost button, opens the live URL via the OS

---

## Components inventory (v1)

The minimum primitives the React frontend needs. Anything not listed: don't build it yet.

- `<Surface variant="0|1|2|3|4">` — wraps children with the right background
- `<HairlineDivider orientation="horizontal|vertical" />`
- `<Button variant="primary|ghost|danger" size="sm|md">` — primary uses `--accent`, ghost is transparent + hairline
- `<IconButton size="sm|md">` — square, mostly used in pane headers
- `<TextInput />` — `surface-1` bg, `border-2`, focus shows `border-strong` + ring
- `<Pill tone="user|project|plugin|info|success|warning|error|neutral">`
- `<KeyChord>⌘K</KeyChord>` — renders a key combo as small mono pills
- `<PaneHeader title icon actions>` — the 28px chrome strip on every pane
- `<Tab title subtitle status="active|idle|streaming|error" active />` — the session tab
- `<CommandPalette />` — controlled overlay, list of items
- `<MarginCard>` — for the highlight-and-ask answer
- `<StatusDot tone color size />`
- `<Pulse>` — wraps a status dot with the pulse animation when active

---

## Files in this directory

- `tokens.css` — every CSS variable above, ready to drop into `src/design/tokens.css` after scaffolding
- `fonts.css` — `@font-face` declarations for Geist + JetBrains Mono using Google Fonts as remote source (offline fallback to system fonts)
- `xterm-theme.ts` — xterm color theme object built from these tokens

These are pre-scaffold artifacts. Task #2 will move them to `src/design/` and wire them into the Tauri+React project.
