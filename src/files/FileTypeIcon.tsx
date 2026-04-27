import type { CSSProperties } from "react";

/**
 * Per-extension file icon. Glyph + tint inspired by VS Code's seti/material
 * icon themes, redrawn at 14px to fit the file-tree row height.
 *
 * Each icon is a single-letter or short-glyph badge in the language's
 * recognizable color. We deliberately do not draw photo-realistic logos —
 * they'd clash with the rest of the chrome's hand-drawn SVG family.
 */

interface Props {
  name: string;
  isDir: boolean;
  open?: boolean;
  size?: number;
  style?: CSSProperties;
}

/* Color uses the workshop-pigment palette where possible so file-type
   tints harmonize with session/project tags. */
const COLOR = {
  rust:    "var(--tag-rust)",     // .rs
  amber:   "var(--tag-amber)",    // .js, .json
  moss:    "var(--tag-moss)",     // .py, .lock
  pine:    "var(--tag-pine)",     // .css, .scss
  slate:   "var(--tag-slate)",    // .ts, .tsx
  iris:    "var(--tag-iris)",     // .md, .mdx
  rose:    "var(--tag-rose)",     // .html, .vue
  neutral: "var(--text-tertiary)",
  accent:  "var(--accent)",
};

interface TypeSpec {
  glyph: string;
  color: string;
}

const TYPES: Record<string, TypeSpec> = {
  // languages
  rs:     { glyph: "Rs", color: COLOR.rust },
  ts:     { glyph: "Ts", color: COLOR.slate },
  tsx:    { glyph: "Tx", color: COLOR.slate },
  js:     { glyph: "Js", color: COLOR.amber },
  jsx:    { glyph: "Jx", color: COLOR.amber },
  mjs:    { glyph: "Js", color: COLOR.amber },
  cjs:    { glyph: "Js", color: COLOR.amber },
  py:     { glyph: "Py", color: COLOR.moss },
  rb:     { glyph: "Rb", color: COLOR.rust },
  go:     { glyph: "Go", color: COLOR.pine },
  java:   { glyph: "Jv", color: COLOR.rose },
  kt:     { glyph: "Kt", color: COLOR.iris },
  swift:  { glyph: "Sw", color: COLOR.amber },
  c:      { glyph: "C",  color: COLOR.slate },
  h:      { glyph: "H",  color: COLOR.slate },
  cpp:    { glyph: "C+", color: COLOR.slate },
  hpp:    { glyph: "H+", color: COLOR.slate },
  cs:     { glyph: "Cs", color: COLOR.iris },
  php:    { glyph: "Ph", color: COLOR.iris },
  lua:    { glyph: "Lu", color: COLOR.slate },
  sh:     { glyph: ">_", color: COLOR.moss },
  zsh:    { glyph: ">_", color: COLOR.moss },
  bash:   { glyph: ">_", color: COLOR.moss },
  fish:   { glyph: ">_", color: COLOR.moss },

  // markup / data
  html:   { glyph: "Ht", color: COLOR.rose },
  htm:    { glyph: "Ht", color: COLOR.rose },
  css:    { glyph: "Cs", color: COLOR.pine },
  scss:   { glyph: "Sc", color: COLOR.pine },
  sass:   { glyph: "Sa", color: COLOR.pine },
  less:   { glyph: "Le", color: COLOR.pine },
  vue:    { glyph: "Vu", color: COLOR.moss },
  svelte: { glyph: "Sv", color: COLOR.rust },
  json:   { glyph: "{}", color: COLOR.amber },
  jsonc:  { glyph: "{}", color: COLOR.amber },
  yaml:   { glyph: "Yl", color: COLOR.rose },
  yml:    { glyph: "Yl", color: COLOR.rose },
  toml:   { glyph: "Tm", color: COLOR.amber },
  xml:    { glyph: "<>", color: COLOR.rose },
  md:     { glyph: "Md", color: COLOR.iris },
  mdx:    { glyph: "Mx", color: COLOR.iris },
  txt:    { glyph: "Tx", color: COLOR.neutral },

  // configs / lock files
  lock:        { glyph: "Lk", color: COLOR.moss },
  gitignore:   { glyph: "Gi", color: COLOR.neutral },
  gitattributes:{ glyph: "Ga", color: COLOR.neutral },
  env:         { glyph: "Ev", color: COLOR.amber },
  dockerfile:  { glyph: "Dk", color: COLOR.slate },
  makefile:    { glyph: "Mk", color: COLOR.amber },

  // images / media
  png:    { glyph: "Im", color: COLOR.iris },
  jpg:    { glyph: "Im", color: COLOR.iris },
  jpeg:   { glyph: "Im", color: COLOR.iris },
  gif:    { glyph: "Im", color: COLOR.iris },
  webp:   { glyph: "Im", color: COLOR.iris },
  svg:    { glyph: "Sv", color: COLOR.amber },
  ico:    { glyph: "Im", color: COLOR.iris },
  pdf:    { glyph: "Pd", color: COLOR.rust },
  mp4:    { glyph: "Vd", color: COLOR.iris },
  mov:    { glyph: "Vd", color: COLOR.iris },

  // archives
  zip:    { glyph: "Zp", color: COLOR.neutral },
  gz:     { glyph: "Gz", color: COLOR.neutral },
  tar:    { glyph: "Tr", color: COLOR.neutral },
};

/* Whole filenames that should map to a particular type, regardless of
   extension. */
const FILENAMES: Record<string, TypeSpec> = {
  ".gitignore":      { glyph: "Gi", color: COLOR.neutral },
  ".gitattributes":  { glyph: "Ga", color: COLOR.neutral },
  ".env":            { glyph: "Ev", color: COLOR.amber },
  ".env.local":      { glyph: "Ev", color: COLOR.amber },
  "Dockerfile":      { glyph: "Dk", color: COLOR.slate },
  "Makefile":        { glyph: "Mk", color: COLOR.amber },
  "Cargo.toml":      { glyph: "Cg", color: COLOR.rust },
  "Cargo.lock":      { glyph: "Cg", color: COLOR.rust },
  "package.json":    { glyph: "Pk", color: COLOR.amber },
  "package-lock.json":{ glyph: "Pk", color: COLOR.amber },
  "bun.lockb":       { glyph: "Bu", color: COLOR.amber },
  "bun.lock":        { glyph: "Bu", color: COLOR.amber },
  "tsconfig.json":   { glyph: "Ts", color: COLOR.slate },
  "README.md":       { glyph: "Rd", color: COLOR.iris },
  "LICENSE":         { glyph: "Lc", color: COLOR.neutral },
};

export function fileTypeFor(name: string): TypeSpec {
  if (FILENAMES[name]) return FILENAMES[name];
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? { glyph: "·", color: COLOR.neutral };
}

export function FileTypeIcon({ name, isDir, open = false, size = 14, style }: Props) {
  if (isDir) return <FolderGlyph open={open} size={size} style={style} />;
  const spec = fileTypeFor(name);
  return (
    <span
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontFamily: "var(--font-mono)",
        fontSize: Math.max(8, size - 6),
        fontWeight: 600,
        letterSpacing: "-0.04em",
        color: spec.color,
        backgroundColor: `color-mix(in oklch, var(--surface-1), ${spec.color} 14%)`,
        borderRadius: "var(--radius-xs)",
        userSelect: "none",
        ...style,
      }}
      aria-hidden
    >
      {spec.glyph}
    </span>
  );
}

function FolderGlyph({
  open,
  size,
  style,
}: {
  open: boolean;
  size: number;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: open ? "var(--accent)" : "var(--text-tertiary)",
        ...style,
      }}
      aria-hidden
    >
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        {open ? (
          <path
            d="M2 5.5C2 4.7 2.7 4 3.5 4h2.4c.4 0 .7.1 1 .4l1.2 1.1H12.5c.8 0 1.5.7 1.5 1.5v.5H4.6c-.6 0-1.2.4-1.4 1L2 12V5.5Z"
            fill="currentColor"
            opacity="0.85"
          />
        ) : (
          <path
            d="M2 5.5C2 4.7 2.7 4 3.5 4h2.4c.4 0 .7.1 1 .4l1.2 1.1H12.5c.8 0 1.5.7 1.5 1.5v4.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5V5.5Z"
            fill="currentColor"
            opacity="0.7"
          />
        )}
      </svg>
    </span>
  );
}
