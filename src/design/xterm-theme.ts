/**
 * RLI xterm.js theme.
 *
 * Hex equivalents of our OKLCH design tokens, plus a tasteful warm-dark
 * 16-color ANSI palette tuned to harmonize with the steel-blue accent
 * and the warm-tinted neutral background.
 *
 * NOT the cyan-on-dark "AI terminal" palette. Lower chroma everywhere,
 * warmer foundation, restrained brights.
 */

import type { ITheme } from "@xterm/xterm";

export const xtermTheme: ITheme = {
  // Surfaces
  background: "#161513",      // surface-0
  foreground: "#f3f1ed",      // text-primary
  cursor: "#5897d0",          // accent
  cursorAccent: "#161513",    // contrast against cursor
  selectionBackground: "#3a4d6a",  // accent-muted, ~40% lightness
  selectionForeground: "#f3f1ed",

  // 16-color ANSI palette — warm-dark instrument
  black:         "#1a1916",
  red:           "#d96e5b",
  green:         "#79b07d",
  yellow:        "#d4a558",
  blue:          "#5897d0",
  magenta:       "#b87dba",
  cyan:          "#6ab2c1",
  white:         "#c8c5be",

  brightBlack:   "#4a4744",
  brightRed:     "#ee8b78",
  brightGreen:   "#92c895",
  brightYellow:  "#e8be72",
  brightBlue:    "#7baee6",
  brightMagenta: "#cc94cd",
  brightCyan:    "#80c8d8",
  brightWhite:   "#f3f1ed",
};

/**
 * The xterm.js terminal options that pair with this theme.
 * Apply alongside the theme when constructing the Terminal instance.
 */
export const xtermOptions = {
  fontFamily:
    '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.35,
  letterSpacing: 0,
  cursorBlink: false,         // confident cursor, no distraction
  cursorStyle: "block" as const,
  cursorWidth: 1,
  scrollback: 10_000,
  smoothScrollDuration: 0,    // never animate scroll — see CONTEXT.md
  drawBoldTextInBrightColors: true,
  allowProposedApi: true,     // needed for WebGL addon + custom shell integration
  minimumContrastRatio: 4.5,
};
