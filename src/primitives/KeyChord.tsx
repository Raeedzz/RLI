import type { CSSProperties } from "react";

interface Props {
  /** Keys in order, e.g. ["⌘", "K"] or ["⌘", "⇧", ";"] */
  keys: string[];
  size?: "sm" | "md";
}

/**
 * Renders a keyboard chord as small mono pills.
 * Used in the command palette right-margin and tooltips.
 */
export function KeyChord({ keys, size = "sm" }: Props) {
  const fontSize = size === "sm" ? "var(--text-2xs)" : "var(--text-xs)";
  const dim = size === "sm" ? 16 : 18;

  const pillStyle: CSSProperties = {
    minWidth: dim,
    height: dim,
    padding: "0 4px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
    fontSize,
    fontWeight: "var(--weight-medium)",
    color: "var(--text-tertiary)",
    backgroundColor: "var(--surface-3)",
    border: "var(--border-1)",
    borderRadius: "var(--radius-xs)",
    fontVariantLigatures: "none",
  };

  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {keys.map((k, i) => (
        <kbd key={`${k}-${i}`} style={pillStyle}>
          {k}
        </kbd>
      ))}
    </span>
  );
}
