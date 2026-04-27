import type { ButtonHTMLAttributes, ReactNode } from "react";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: "sm" | "md";
  children: ReactNode;
}

/**
 * Square button used in pane headers, tab close buttons, etc.
 * - sm = 20px (tab close, inline actions)
 * - md = 24px (pane header actions)
 */
export function IconButton({
  size = "md",
  children,
  style,
  ...rest
}: Props) {
  const dim = size === "sm" ? 20 : 24;
  return (
    <button
      type="button"
      className="rli-press"
      {...rest}
      style={{
        width: dim,
        height: dim,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-sm)",
        color: "var(--text-tertiary)",
        backgroundColor: "transparent",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
        e.currentTarget.style.color = "var(--text-primary)";
        rest.onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--text-tertiary)";
        rest.onMouseLeave?.(e);
      }}
    >
      {children}
    </button>
  );
}
